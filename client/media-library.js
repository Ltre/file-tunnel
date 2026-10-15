(function () {
    'use strict';
    const $ = id => document.getElementById(id), root = '/api/media-library';
    const titles = { infra: '基础设施设置', imports: '资源导入', sessions: '提取会话', collection: '收藏资源库', entities: '标签与人物', status: '系统状态' };
    const states = { ready: '导入就绪', 'awaiting-task': '等待创建下载任务', 'waiting-download': '等待下载', 'download-failed': '抓取失败', queued: '排队中',
        receiving: '正在接收本地文件', transferring: '正在转存网盘', 'import-failed': '导入失败', running: '执行中', completed: '已完成', failed: '失败', cancelled: '已取消', expired: '已到期清理', interrupted: '中断待恢复', deleted: '已删除' };
    let data = { imports: [], sessions: [], results: [], collections: [], entities: [], jobs: [], caches: [], events: [] }, tab = 'infra', sessionId = '', playerOffset = 0, selection = new Set(), polling = null, activeUpload, stateRevision = 0;
    let lastView = '', collectionQuery = '', collectionEntity = '', disposePlayer = () => {};
    const el = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
    const notice = (text, failed = false) => { $('ml-notice').textContent = text; $('ml-notice').className = failed ? 'error' : ''; };
    const bytes = n => !n ? '0 B' : n < 1024 ? n + ' B' : (n / (n >= 1024 ** 3 ? 1024 ** 3 : n >= 1024 ** 2 ? 1024 ** 2 : 1024)).toFixed(1) + (n >= 1024 ** 3 ? ' GB' : n >= 1024 ** 2 ? ' MB' : ' KB');
    const time = ms => { if (!Number.isFinite(ms)) return '—'; const seconds = ms / 1000, hours = Math.floor(seconds / 3600), mins = Math.floor(seconds / 60) % 60; return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${(seconds % 60).toFixed(3).padStart(6, '0')}`; };
    const date = n => n ? new Date(n).toLocaleString() : '—';
    const compressionStatus=job=>'压缩转码 · '+(states[job.state]||job.state)+' · '+(job.progress||0)+'% · '+(job.state==='completed'?'压缩版本已就绪':job.message||job.error||(['cancelled','interrupted'].includes(job.state)?'处理已停止':job.detail||'等待处理'));
    async function api(route, options = {}) {
        const response = await fetch(route.startsWith('/api/') ? route : root + route, { credentials: 'same-origin', cache: 'no-store', ...options });
        const value = await response.json(); if (!response.ok) throw Error((value.message || value.error || '操作失败') + (value.error ? ` [${value.error}]` : '')); return value;
    }
    const json = (method, body = {}) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    function button(text, action, cls = '') {
        const node = el('button', text, cls); node.type = 'button'; if(cls==='ml-notes-toggle'){node.title='会话备注';node.setAttribute('aria-label','会话备注');}
        node.onclick = async () => { if (node.disabled) return; node.disabled = true; node.classList.add('loading');
            try { await action(node); } catch (error) { notice(error.message, true); } finally { node.disabled = false; node.classList.remove('loading'); } }; return node;
    }
    const card = (title, description) => { const node = el('section', undefined, 'ml-card'); if (title) node.append(el('h2', title)); if (description) node.append(el('p', description)); return node; };
    const input = (value = '', type = 'text') => { const node = document.createElement('input'); node.type = type; node.value = value; return node; };
    const label = (text, control) => { const node = el('label', text); node.append(control); return node; };
    function select(values, selected) { const node = document.createElement('select'); values.forEach(([id, name]) => node.add(new Option(name, id))); if (selected !== undefined) node.value = selected; return node; }
    const badge = (state, text = states[state] || state) => el('span', text, 'ml-badge ' + state);
    function dialog(title, body, actions = []) {
        $('ml-dialog-title').textContent = title; $('ml-dialog-body').replaceChildren(body); $('ml-dialog-actions').replaceChildren(...actions, button('关闭', () => $('ml-dialog').close()));
        if (!$('ml-dialog').open) $('ml-dialog').showModal();
    }
    function changeTab(next) { tab = next; document.querySelectorAll('[data-tab]').forEach(node => { node.classList.toggle('active', node.dataset.tab === tab); node.setAttribute('aria-selected', String(node.dataset.tab === tab)); }); render(); }
    function rememberRecord(kind, record) {
        const records = data[kind], index = records.findIndex(value => value.id === record.id);
        if (index < 0) records.unshift(record); else records[index] = record;
        stateRevision++;
    }
    async function refresh(redraw = false) {
        while (polling) { await polling; if (!redraw) return; }
        const revision = stateRevision;
        const flight = (async () => {
            const snapshot = await api('/state');
            // A response started before a successful mutation must not erase
            // the returned session, Clip job or collection from the local UI.
            if (revision !== stateRevision) return;
            data = snapshot; const version = JSON.stringify(data);
            if ((redraw || version !== lastView && ['imports', 'status', 'collection', 'entities'].includes(tab)) && !$('ml-dialog').open && !activeUpload && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) render();
            else if (tab === 'sessions' && version !== lastView) {
                const chooser = $('ml-session-picker');
                if (chooser) { chooser.replaceChildren(...data.sessions.filter(s => s.state === 'active').map(s => new Option(s.name, s.id))); chooser.value = sessionId; }
                renderResults();
            }
            lastView = version;
        })();
        polling = flight;
        try { await flight; } finally { if (polling === flight) polling = null; }
    }
    async function accounts() {
        const status = await api('/api/telegram/drive/accounts'); return (status.accounts || []).filter(a => !a.reauthRequired).map(a => a.identity);
    }
    async function chooseDisk(title, purpose, fileMode = false) {
        const saved = await accounts(), body = el('div', undefined, 'ml-stack');
        if (!saved.length) { body.append(el('p', '请先在前台网盘登录，再回此处继续选择。')); const link = el('a', '打开网盘登录'); link.href = '/disk'; link.target = '_blank'; link.rel = 'noopener'; body.append(link); dialog(title, body, [button('重新检查登录', () => chooseDisk(title, purpose, fileMode))]); return; }
        const configured = data.config?.[purpose], actor = select(saved.map(a => [a.id, a.name || a.username || a.id]), configured?.userId);
        const partition = select([]), chosen = input(configured?.path ? '/' + configured.path : '/'); chosen.readOnly = true;
        const top = el('div', undefined, 'ml-row'); top.append(label('账号', actor), label('分区', partition));
        const tree = el('div', undefined, 'ml-tree'), selectedFiles = new Map(); let directory = '', generation = 0;
        body.append(top, label('目标目录', chosen), tree);
        function optionsForAccount() { return { headers: { 'X-Disk-Account': actor.value } }; }
        async function load(partitionsToo = false) {
            const request = ++generation, accountId = actor.value;
            tree.replaceChildren(el('p', '正在读取本机网盘目录…'));
            const info = await api('/locations?disk_space=' + encodeURIComponent(partition.value || ''), { headers: { 'X-Disk-Account': accountId } });
            if (request !== generation) return;
            if (partitionsToo) { partition.replaceChildren(...info.partitions.map(p => new Option(p.name, p.scopeKey))); partition.value = configured?.userId === accountId ? configured.diskSpace : ''; if (partition.value) return load(false); }
            const path = info.directories.some(d => d.path === directory) ? directory : ''; directory = path; chosen.value = '/' + path;
            tree.replaceChildren();
            const folders = [{ path: '', name: '根目录' }, ...info.directories];
            for (const folder of folders) {
                const row = button('📁 ' + (folder.name || folder.path.split('/').at(-1)), async () => {
                    directory = folder.path; chosen.value = '/' + directory; tree.querySelectorAll('button').forEach(n => n.classList.remove('selected')); row.classList.add('selected');
                    if (fileMode) await loadFiles(directory, request, accountId);
                }, folder.path === path ? 'selected' : '');
                row.style.paddingLeft = (12 + folder.path.split('/').filter(Boolean).length * 14) + 'px'; row.title = '/' + folder.path; tree.append(row);
            }
            if (fileMode) await loadFiles(path, request, accountId);
        }
        async function loadFiles(path, request, accountId) {
            body.querySelector('[data-files]')?.remove();
            const listing = await api('/api/telegram/drive/list?path=' + encodeURIComponent(path) + '&disk_space=' + encodeURIComponent(partition.value), { headers: { 'X-Disk-Account': accountId } });
            if (request !== generation || accountId !== actor.value || path !== directory) return;
            const list = el('div', undefined, 'ml-stack'); list.dataset.files = '';
            for (const file of listing.files || []) { const checkbox = input('', 'checkbox'); checkbox.checked = selectedFiles.has(file.id);
                checkbox.onchange = () => checkbox.checked ? selectedFiles.set(file.id, { ...file, userId: actor.value, diskSpace: partition.value }) : selectedFiles.delete(file.id);
                list.append(label('📄 ' + file.name + ' · ' + bytes(file.size), checkbox)); }
            if (!listing.files?.length) list.append(el('p', '这个目录没有文件。')); body.append(list);
        }
        actor.onchange = async () => { directory = ''; selectedFiles.clear(); try { await load(true); } catch (e) { notice(e.message, true); } };
        partition.onchange = async () => { directory = ''; selectedFiles.clear(); try { await load(); } catch (e) { notice(e.message, true); } };
        const action = button(fileMode ? '导入选中文件' : '授权并保存位置', async () => {
            if (fileMode) { if (!selectedFiles.size) throw Error('请选择文件'); for (const file of selectedFiles.values()) await api('/imports', { ...json('POST', { kind: 'disk', userId: file.userId, diskSpace: file.diskSpace, fileId: file.id }), headers: { 'Content-Type': 'application/json', 'X-Disk-Account': file.userId } }); changeTab('imports'); }
            else { await api('/config/' + purpose, { ...json('PUT', { userId: actor.value, diskSpace: partition.value, path: directory }), headers: { 'Content-Type': 'application/json', 'X-Disk-Account': actor.value } }); }
            $('ml-dialog').close(); await refresh(true); notice(fileMode ? '已建立导入记录，源文件仍归原网盘。' : '已授权子系统在该位置独立处理后台任务，可在设置中撤销。');
        }, 'primary');
        dialog(title, body, [button('新建多级目录', async () => { const name = prompt('目录名称，可用 / 创建多级目录'); if (!name) return; const path = [directory, name].filter(Boolean).join('/');
            await api('/api/telegram/drive/directories?disk_space=' + encodeURIComponent(partition.value), { ...json('POST', { path }), headers: { 'Content-Type': 'application/json', ...optionsForAccount().headers } }); directory = path; await load(); }), action]);
        await load(true);
    }
    function renderInfra() {
        const layout = el('div', undefined, 'ml-layout'), main = el('div'), aside = el('aside'); layout.append(main, aside);
        for (const [purpose, title, description] of [['workspace', '① 工作区存储设置', '管理本系统导入的源视频及图片，默认保留一年；直接引用的外部文件不受此期限控制。'], ['collection', '② 正式收藏存储设置', '正式选择的画面和 Clip 独立保存，不随源视频或提取会话清理。']]) {
            const box = card(title, description), setting = data.config?.[purpose];
            box.append(el('p', setting ? `${setting.userName || setting.userId} · ${setting.partitionName || '默认分区'} · /${setting.path}` : '尚未配置')); box.append(button(setting ? '重新选择并授权' : '选择账号、分区和目录', () => chooseDisk(title, purpose), 'primary'));
            if (setting) box.append(button('撤销后台访问授权', async () => { if (!confirm('撤销后，后台转存和处理将停止使用此授权，已保存文件保留。确认？')) return; await api('/grants/' + setting.grantId, { method: 'DELETE' }); notice('授权已撤销'); }, 'danger')); main.append(box);
        }
        const local = card('③ 本机临时缓存', '默认位于本项目 .tunnel-data/cache。可填写其它服务器目录；只清理专属子目录和登记的文件，不删除该路径中的其它内容。');
        const fields = {}, settings = data.config?.caches;
        for (const [kind, title] of [['segments', '视频片段'], ['candidates', '候选图片 / Clip / 参考图']]) {
            const existing = settings?.[kind]; fields[kind] = { root: input(existing?.root || (kind === 'segments' ? '.tunnel-data/cache/video-segments' : '.tunnel-data/cache/media-candidates')),
                size: input(existing ? existing.maxBytes / 1024 ** 3 : kind === 'segments' ? 10 : 5, 'number'), days: input(existing?.ttlDays || (kind === 'segments' ? 7 : 30), 'number') };
            local.append(el('h3', title), label('路径', fields[kind].root), label('容量上限（GB）', fields[kind].size), label('期限（天）', fields[kind].days));
        }
        local.append(button('保存缓存策略', async () => { await api('/cache-policies', json('PUT', Object.fromEntries(Object.entries(fields).map(([kind, field]) => [kind, { root: field.root.value, maxBytes: Math.round(Number(field.size.value) * 1024 ** 3), ttlDays: Number(field.days.value) }])))); await refresh(true); notice('缓存策略已保存'); }, 'primary')); main.append(local);
        const explanation = card('五类存储互相独立', '工作区、正式收藏、片段缓存、候选缓存和业务 SQLite 各有自己的生命周期。运行中的任务会保护其缓存。');
        explanation.append(el('p', '工作区授权是此后台子系统专用授权，不通过外部域名连接网盘，不保存浏览器会话到 URL。'), button('检查连接、权限与媒体工具', async () => { const status = await api('/check', json('POST')); dialog('基础设施检查', el('pre', JSON.stringify(status, null, 2))); })); aside.append(explanation); return layout;
    }
    function renderImports() {
        const layout = el('div', undefined, 'ml-layout'), main = el('div'), aside = card('导入流程', '1. 选择已有资源或到现有下载页创建任务\n2. 服务端转存工作区\n3. 创建提取会话或正式收录'); layout.append(main, aside);
        const box = card('导入视频或图片', '已有网盘资源直接引用；下载成品和本地上传先保存到工作区。'); const sources = el('div', undefined, 'ml-grid');
        sources.append(button('SNS 已完成任务', () => chooseTask('sns')), button('YouTube Premium 任务', () => chooseTask('youtube')), button('从网盘选择', () => chooseDisk('选择原生网盘文件', 'workspace', true)), button('本地上传', () => $('ml-local-file').click()));
        const picker = input('', 'file'); picker.id = 'ml-local-file'; picker.hidden = true; picker.multiple = true; picker.accept = 'video/*,image/*';
        const stopUpload = button('取消本地上传', () => activeUpload?.abort(), 'danger'); stopUpload.hidden = true;
        picker.onchange = async () => { activeUpload = new AbortController(); stopUpload.hidden = false;
            try { if (!data.config?.workspace) throw Error('请先设置工作区'); for (const file of picker.files) { notice('正在将 ' + file.name + ' 完整送达本机服务器，请勿关页…');
            await api('/uploads', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Media-Name': encodeURIComponent(file.name), 'X-Media-Size': String(file.size), 'X-Media-Type': file.type,
                'X-Disk-Account': data.config.workspace.userId }, signal: activeUpload.signal, body: file }); } notice('文件已完整到达服务器，后续转存可在关页后继续'); }
            catch (error) { notice(error.name === 'AbortError' ? '已取消当前本地上传；此前完整到达服务器的文件继续后台处理。' : error.message, true); }
            finally { activeUpload = null; stopUpload.hidden = true; picker.value = ''; await refresh(true); } };
        const url = input(''); url.type = 'url'; url.placeholder = '粘贴 SNS / YouTube 链接'; const link = el('div', undefined, 'ml-row');
        link.append(url, button('去原下载页创建任务', async () => {
            // Open synchronously while user activation is still available.
            const page = window.open('about:blank', '_blank');
            if (!page) throw Error('新标签页被浏览器拦截，请允许弹出页面后重试。');
            page.opener = null;
            try { const value = await api('/links', json('POST', { url: url.value })); const target = new URL(value.url, location.origin);
                if (target.origin !== location.origin || !['/sns-dl', '/youtube-premium-dl'].includes(target.pathname)) throw Error('下载页面地址无效');
                page.location.replace(target.href);
            } catch (error) { page.close(); throw error; }
        }, 'primary'));
        box.append(sources, picker, stopUpload, link); main.append(box);
        const list = card('导入记录', '只有网盘保存确认完成且媒体读取有效时，才显示“导入就绪”。');
        for (const resource of data.imports) { const entry = card('', ''), actions = el('div', undefined, 'ml-actions'); entry.append(el('div', resource.name, 'ml-item-name'), badge(resource.state), el('p', `${resource.kind} · ${resource.source?.taskId || '无下载任务'} · ${resource.duration ? time(resource.duration * 1000) : ''} · ${date(resource.createdAt)}`));
            if (resource.state === 'ready') { if (resource.duration) actions.append(button('新建提取会话', async () => {
                const name = prompt('会话名称', resource.name || '提取会话'); if (name === null) return;
                const session = await api('/sessions', json('POST', { importId: resource.id, name: name || '提取会话' }));
                rememberRecord('sessions', session); sessionId = session.id; selection.clear(); changeTab('sessions');
                refresh(true).catch(error => notice(error.message, true));
            }));
                actions.append(button('正式收录', async () => { if (!confirm('保存到正式收藏位置？直接引用外部文件请在下一步选择；收藏不随工作区到期删除。')) return;
                    const external = !resource.managed && confirm('仅保留外部网盘文件引用？确定：直接引用；取消：独立转存到正式收藏区。'); await api('/imports/' + resource.id + '/collect', json('POST', { external })); await refresh(true); notice('已建立正式收录任务'); }));
                if (resource.managed) actions.append(button('续期一年', async () => { await api('/imports/' + resource.id, json('PATCH', { days: 365 })); await refresh(true); }));
            } else actions.append(button('取消导入', async () => { if (confirm('只取消此导入，不取消原 SNS/YT 下载任务，不删除已有成果。')) { await api('/imports/' + resource.id + '/cancel', json('POST')); await refresh(true); } }, 'danger'));
            if (['download-failed', 'import-failed', 'cancelled'].includes(resource.state)) actions.append(button('重试导入', async () => { await api('/imports/' + resource.id + '/retry', json('POST')); await refresh(true); }));
            if (resource.error) entry.append(el('p', `${resource.message || '导入尚未完成，请检查来源任务和授权。'} [${resource.error}]`, 'ml-warning')); if (resource.file) entry.append(el('div', `${resource.file.partitionName || resource.file.diskSpace || '默认分区'} · /${[resource.file.path, resource.file.name || resource.name].filter(Boolean).join('/')}${resource.available ? '' : ' · 来源当前不可用'}`, 'ml-muted'));
            entry.append(actions); list.append(entry); }
        if (!data.imports.length) list.append(el('p', '暂无导入资源。')); main.append(list); return layout;
    }
    async function chooseTask(kind) {
        const body = el('div', undefined, 'ml-stack'); let page = 1;
        const load = async () => { const value = await api('/download-tasks/' + kind + '?page=' + page); body.replaceChildren();
            for (const task of value.tasks) { const row = button(`${task.title || task.outputFileName || task.id} · ${task.status}`, async () => { await api('/imports', json('POST', { kind, taskId: task.id })); $('ml-dialog').close(); await refresh(true); }); row.disabled = task.status !== 'completed' || !task.hasFile; body.append(row); }
            const paging = el('div', undefined, 'ml-row'); paging.append(button('上一页', async () => { page = Math.max(1, page - 1); await load(); }), el('span', `${value.page}/${value.pages}`), button('下一页', async () => { page = Math.min(value.pages, page + 1); await load(); })); body.append(paging); };
        dialog('选择已完成且仍有服务端成品的任务', body); await load();
    }
    function currentSession() { return data.sessions.find(s => s.id === sessionId && s.state === 'active'); }
    function renderSessions() {
        if (!currentSession()) sessionId = data.sessions.find(s => s.state === 'active')?.id || '';
        const session = currentSession(), panel = card('提取会话'), chooser = select(data.sessions.filter(s => s.state === 'active').map(s => [s.id, s.name]), sessionId);
        chooser.id = 'ml-session-picker'; chooser.onchange = () => { sessionId = chooser.value; selection.clear(); render(); }; panel.append(label('当前会话', chooser));
        if(session){const notes=el('div',undefined,'ml-session-notes'),memo=el('textarea');memo.maxLength=65535;memo.value=session.remark||'';memo.placeholder='会话备注（最多 65535 字符）';notes.hidden=true;notes.append(memo,button('保存会话备注',async()=>{const saved=await api('/sessions/'+session.id,json('PATCH',{remark:memo.value,version:session.version}));rememberRecord('sessions',saved);session.version=saved.version;notice('会话备注已保存');}));panel.querySelector('h2')?.append(button('▤',()=>{notes.hidden=!notes.hidden;},'ml-notes-toggle'));panel.append(notes);}
        if (!session) { panel.append(el('p', '请在“资源导入”中选择一个就绪视频，新建提取会话。')); return panel; }
        const resource = data.imports.find(r => r.id === session.importId); if (!resource) { panel.append(el('p', '源记录不存在')); return panel; }
        panel.append(el('p', `${resource.name} · 时长 ${time(resource.duration * 1000)} · ${resource.available ? '来源可读' : '来源当前失效'}`));
        const layout = el('div', undefined, 'ml-session-layout'), parameters = card('取帧方式'), center = el('section'), right = card('手动 Clip'); layout.append(parameters, center, right); panel.append(layout);
        const mode = select([['random', '范围内随机取帧'], ['interval', '等间隔取帧']]), ranges = input(''), count = input(24, 'number'), interval = input('', 'number'); ranges.placeholder = '全视频或 12:34-56:01,01:02:10-01:05:30';
        parameters.append(label('模式', mode), label('时间范围', ranges), label('随机数量', count), label('间隔（毫秒）', interval), el('p', '随机模式不填间隔时直接抽取指定数量；等间隔模式必须填写间隔。每批最多 500 张。'));
        parameters.append(button('开始取帧', async () => { await api('/sessions/' + session.id + '/extract', json('POST', { mode: mode.value, ranges: ranges.value, count: Number(count.value), intervalMs: Number(interval.value), minIntervalMs: Number(interval.value) })); notice('取帧任务已排队，可关页后回来继续查看'); }, 'primary'));
        const player = document.createElement('video'); player.id = 'ml-player'; player.className = 'ml-preview'; player.controls = true; player.preload = 'metadata'; player.src = root + '/files/' + resource.id;
        playerOffset = 0; let steppedFrame = null, playerOrigin = Number(resource.probe?.format?.start_time) || 0, sourceCacheId = '', sourceVersion = 0, frameAbort, segmentWaiting, previewAbort, previewStop;
        disposePlayer = () => { previewAbort?.abort(); if(previewStop)player.removeEventListener('timeupdate',previewStop); frameAbort?.abort(); clearInterval(segmentWaiting); player.pause(); };
        const playerTime = () => player.paused && steppedFrame && Math.abs(player.currentTime - steppedFrame.position) < .001 ? steppedFrame.time : Math.max(0, player.currentTime - playerOrigin) + playerOffset;
        const clock = el('output', '00:00:00.000'); player.ontimeupdate = () => { clock.textContent = time(playerTime() * 1000); };
        player.onerror = () => notice('浏览器可能不支持源视频编码。可先生成下方工作片段，以兼容 MP4 播放后继续操作。', true);
        const start = input('0'), end = input(String(Math.min(resource.duration, 30))), audio = input('', 'checkbox'); audio.checked = true;
        const precision = select([['precise', '精确裁切（重新编码、高画质）'], ['fast', '快速裁切（流复制，切点可能偏移）']]);
        const line = el('div', undefined, 'ml-player-line');
        let stepping = false;
        const step = async direction => {
            if (stepping) return; stepping = true; player.pause();
            const version = sourceVersion, abort = new AbortController(); frameAbort = abort;
            try {
                await waitMediaMetadata(player, abort.signal);
                const at = playerTime();
                const value = await api('/imports/' + resource.id + '/frame-neighbor?time=' + encodeURIComponent(at)
                    + '&player_time=' + encodeURIComponent(player.currentTime) + (sourceCacheId ? '&cache_id=' + encodeURIComponent(sourceCacheId) : ''), { signal: abort.signal });
                if (!player.isConnected || sessionId !== session.id || version !== sourceVersion) return;
                playerOrigin = value.timelineOrigin || 0;
                const target = value[direction];
                if (!Number.isFinite(target)) throw Error(direction === 'previous' ? '已经到达第一帧，或附近未找到可确认的上一帧。' : '已经到达最后一帧，或附近未找到可确认的下一帧。');
                const seek = value[direction + 'Position'] ?? ((value[direction + 'SeekTime'] ?? target) - playerOffset + playerOrigin);
                if (seek < 0 || Number.isFinite(player.duration) && seek >= player.duration) throw Error('目标帧不在当前播放片段内。');
                await seekMediaFrame(player, seek, value[direction + 'FrameTime'] ?? target - playerOffset + playerOrigin, abort.signal);
                if (version !== sourceVersion || !player.isConnected) return;
                steppedFrame = { position: seek, time: target };
                clock.textContent = time(target * 1000);
            } catch (error) { if (!abort.signal.aborted) throw error;
            } finally { stepping = false; }
        };
        line.append(button('← 上一帧', () => step('previous')), button('下一帧 →', () => step('next')), clock,
            button('设为起点', () => { player.pause(); start.value = playerTime().toFixed(3); }), button('设为终点', () => { player.pause(); end.value = playerTime().toFixed(3); }));
        player.onkeydown = event => { if (player.paused && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); step(event.key === 'ArrowLeft' ? 'previous' : 'next').catch(error => notice(error.message, true)); } };
        center.append(player, line);
        const controls = el('div', undefined, 'ml-row'), order = select([['time', '按实际播放时刻'], ['created', '按提取时间']]), unsaved = input('', 'checkbox'); order.id = 'ml-frame-order'; unsaved.id = 'ml-frame-unsaved';
        order.onchange = renderResults; unsaved.onchange = renderResults;
        controls.append(order, label('只看未收藏', unsaved), button('收藏选中画面', async () => { if (!selection.size) throw Error('请先选择画面'); for (const id of [...selection]) await collectCandidate(id); selection.clear(); renderResults(); }));
        const results = el('div', undefined, 'ml-grid'); results.id = 'ml-results'; center.append(controls, results);
        right.append(label('起点（秒或时间）', start), label('终点', end), label('保留音频', audio), label('裁切方式', precision), el('p', '暂停播放器设定端点，左右键使用实际视频帧时间。快速裁切不承诺任意毫秒精度。'));
        const clipInput = () => ({ start: start.value, end: end.value, audio: audio.checked, precise: precision.value === 'precise' });
        let segmentBusy = false;
        const segmentFeedback = el('div', undefined, 'ml-segment-feedback'); segmentFeedback.hidden = true; segmentFeedback.setAttribute('role', 'status');
        const paintSegment = job => {
            segmentFeedback.hidden = false;
            const running = ['queued', 'running', 'loading'].includes(job.state);
            segmentFeedback.classList.toggle('is-running', running);
            const percent = Math.max(0, Math.min(100, Number(job.progress) || 0)), meter = el('progress'); meter.max = 100; meter.value = percent;
            const duration = Number(job.durationSeconds), processed = Number(job.processedSeconds);
            segmentFeedback.replaceChildren(el('strong', `${states[job.state] || (job.state === 'loading' ? '载入播放器' : job.state)} · ${percent}%`),
                el('span', job.state === 'completed' ? '片段已准备完成并载入播放器' : ['failed', 'cancelled', 'interrupted'].includes(job.state) ? job.message || job.error || states[job.state] : job.detail || job.message || (job.state === 'queued' ? '等待前面的处理任务完成' : '正在准备工作片段')),
                ...(Number.isFinite(duration) && Number.isFinite(processed) ? [el('small', `已处理 ${Math.min(processed, duration).toFixed(2)} / ${duration.toFixed(2)} 秒`)] : []), meter);
        };
        const original = button('返回原视频', async () => {
            const at = playerTime();
            changeSource('', 0, Number(resource.probe?.format?.start_time) || 0);
            await waitMediaMetadata(player);
            if (!player.isConnected || sessionId !== session.id || sourceCacheId) return;
            player.currentTime = Math.min(Math.max(0, at) + playerOrigin, Math.max(playerOrigin, player.duration - .001));
            clock.textContent = time(at * 1000); notice('已返回完整原视频');
        }); original.hidden = true;
        function changeSource(cacheId, offset, origin = 0) {
            clearInterval(segmentWaiting); segmentWaiting = null;
            sourceVersion++; previewAbort?.abort(); frameAbort?.abort(); steppedFrame = null;
            player.pause(); sourceCacheId = cacheId; playerOffset = offset; playerOrigin = origin;
            player.src = cacheId ? root + '/cache/' + cacheId : root + '/files/' + resource.id; player.load();
            original.hidden = !cacheId;
        }
        const previewFeedback=el('div',undefined,'ml-preview-feedback ml-segment-feedback');previewFeedback.hidden=true;let previewing=false;
        right.append(button('预览选定范围', async () => {
            if(previewing)return;previewing=true;previewFeedback.hidden=false;previewFeedback.textContent='正在读取媒体信息，准备定位…';
            const version=sourceVersion;previewAbort?.abort();const abort=previewAbort=new AbortController();let reportBuffer;
            try{await waitMediaMetadata(player,abort.signal); if(version!==sourceVersion)throw Error('播放来源已切换'); const parse = v => v.split(':').map(Number).reduce((n, value) => n * 60 + value, 0); const begin = parse(start.value), finish = parse(end.value);
            if (!(begin >= playerOffset && finish > begin)) throw Error('请先设置有效端点'); if(finish>playerOffset+player.duration||begin<playerOffset)throw Error('所选范围不在当前视频内，请返回原视频或重新设定端点');
            const target=begin-playerOffset+playerOrigin;previewFeedback.textContent='正在定位到 '+time(begin*1000)+'，等待视频帧…';steppedFrame=null;
            player.pause();player.currentTime=target;
            reportBuffer=()=>{let loaded=0;for(let i=0;i<(player.buffered?.length||0);i++)loaded+=Math.max(0,Math.min(player.buffered.end(i),finish-playerOffset+playerOrigin)-Math.max(player.buffered.start(i),target));previewFeedback.textContent='正在定位、缓冲并开始播放…'+(loaded?' · 选定范围已缓冲 '+Math.min(100,Math.floor(loaded/(finish-begin)*100))+'%':'');};
            player.addEventListener('progress',reportBuffer);reportBuffer();if(previewStop)player.removeEventListener('timeupdate',previewStop);
            const playback=player.play();abort.signal.addEventListener('abort',()=>player.pause(),{once:true});await playback;
            if(abort.signal.aborted||version!==sourceVersion)return;previewFeedback.textContent='正在播放选定范围';
            const stop = previewStop = () => { if (version !== sourceVersion || playerTime() >= finish) { if (version === sourceVersion) player.pause(); player.removeEventListener('timeupdate', stop); } }; player.addEventListener('timeupdate', stop); }catch(error){previewFeedback.textContent=abort.signal.aborted?'预览已取消':'预览未开始：'+error.message;if(!abort.signal.aborted)throw error;}finally{if(reportBuffer)player.removeEventListener('progress',reportBuffer);previewing=false;} }), previewFeedback,
            button('生成候选 Clip', async () => { const job = await api('/sessions/' + session.id + '/clip', json('POST', clipInput()));
                rememberRecord('jobs', job); renderResults(); notice('裁切已排队；候选区可查看执行状态'); }, 'primary'),
            button('缓存工作片段并播放', async () => {
                if (segmentBusy) return;
                segmentBusy = true; paintSegment({ state: 'running', progress: 0, detail: '正在提交工作片段任务' });
                let job;
                try { job = await api('/sessions/' + session.id + '/segment', json('POST', { ...clipInput(), precise: true })); }
                catch (error) { segmentBusy = false; paintSegment({ state: 'failed', detail: error.message }); throw error; }
                rememberRecord('jobs', job); paintSegment(job);
                clearInterval(segmentWaiting);
                notice('正在准备可复用工作片段，状态页可查看进度'); const waiting = segmentWaiting = setInterval(async () => { if (tab !== 'sessions' || sessionId !== session.id || !player.isConnected) { clearInterval(waiting); return; }
                    try { await refresh(); const current = data.jobs.find(j => j.id === job.id);
                    if (!player.isConnected || sessionId !== session.id || segmentWaiting !== waiting) return;
                    if (current) paintSegment(current.state === 'completed' ? { ...current, state: 'loading', detail: '处理已完成，正在载入播放器' } : current);
                    if (current?.state === 'completed') { clearInterval(waiting); changeSource(current.result.cacheId, Number(job.context.start)); const version = sourceVersion; let loaded = false;
                        try { await waitMediaMetadata(player); if (player.isConnected && version === sourceVersion) { paintSegment(current); loaded = true; } }
                        catch (error) { if (player.isConnected && version === sourceVersion) paintSegment({ state: 'failed', progress: 100, detail: '片段已生成，但播放器载入失败：' + error.message }); }
                        segmentBusy = false; if (loaded) notice('工作片段就绪，后续取帧和裁切会复用它；可点击“返回原视频”切回完整视频'); }
                    else if (['failed', 'cancelled'].includes(current?.state)) { clearInterval(waiting); segmentWaiting = null; segmentBusy = false; notice(current.message || current.error || states[current.state], true); }
                    } catch (error) { if (player.isConnected && segmentWaiting === waiting) paintSegment({ state: 'running', progress: data.jobs.find(j => j.id === job.id)?.progress, detail: '暂时无法读取进度，后台处理仍在继续：' + error.message }); } }, 1000); }),
            segmentFeedback,
            original,
            button('删除此会话记录', async () => { if (!confirm('停止使用此会话？正式收藏仍保留，帧日志和缓存不会被级联删除。')) return; await api('/sessions/' + session.id, { method: 'DELETE' }); await refresh(); sessionId = ''; render(); }, 'danger'));
        setTimeout(renderResults, 0); return panel;
    }
    function waitMediaMetadata(player, signal) {
        if (signal?.aborted) return Promise.reject(new DOMException('已取消', 'AbortError'));
        if (player.error) return Promise.reject(Error('视频加载失败，请确认浏览器支持该编码，或先缓存兼容工作片段。'));
        if (player.readyState >= 1) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const finish = error => { clearTimeout(timer); player.removeEventListener('loadedmetadata', ready); player.removeEventListener('error', failed); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
            const ready = () => finish(), failed = () => finish(Error('视频加载失败，请确认浏览器支持该编码，或先缓存兼容工作片段。'));
            const abort = () => finish(new DOMException('已取消', 'AbortError'));
            const timer = setTimeout(() => finish(Error('视频信息仍在加载，请稍后重试。')), 15000);
            player.addEventListener('loadedmetadata', ready); player.addEventListener('error', failed); signal?.addEventListener('abort', abort, { once: true });
        });
    }
    function seekMediaFrame(player, position, frameTime, signal) {
        return new Promise((resolve, reject) => {
            let seeked = false, presented = false, callback, settled = false;
            const finish = error => {
                if (settled) return; settled = true; clearTimeout(timer);
                player.removeEventListener('seeked', onSeeked); player.removeEventListener('error', onError);
                signal?.removeEventListener('abort', onAbort);
                if (callback !== undefined) player.cancelVideoFrameCallback?.(callback);
                error ? reject(error) : resolve();
            };
            const onError = () => finish(Error('视频定位失败，浏览器可能不支持该视频编码。'));
            const onAbort = () => finish(new DOMException('已取消', 'AbortError'));
            const onSeeked = () => {
                seeked = true;
                if (!player.requestVideoFrameCallback) requestAnimationFrame(() => requestAnimationFrame(() => finish()));
                else if (presented) finish();
            };
            const observe = () => { callback = player.requestVideoFrameCallback((_now, metadata) => {
                if (settled) return;
                presented = Math.abs(metadata.mediaTime - frameTime) < .003;
                if (presented && seeked) finish(); else observe();
            }); };
            const timer = setTimeout(() => finish(Error('等待视频帧显示超时，请确认视频可以正常播放后重试。')), 15000);
            player.addEventListener('seeked', onSeeked); player.addEventListener('error', onError);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) return onAbort();
            try { if (player.requestVideoFrameCallback) observe(); player.currentTime = position; }
            catch (error) { finish(error); }
        });
    }
    const collecting = new Set();
    const collectionErrors = new Map();
    async function collectCandidate(id) {
        if (collecting.has(id)) return;
        collecting.add(id); collectionErrors.delete(id); renderResults();
        try {
            const record = await api('/results/' + id + '/collect', json('POST'));
            rememberRecord('collections', record);
            notice(record.state === 'ready' ? '已经收藏到网盘' : '已建立收藏转存任务，确认落盘后才标记已收藏');
        } catch (error) { collectionErrors.set(id, error.message); throw error; }
        finally { collecting.delete(id); renderResults(); }
    }
    function renderCollectionProgress(result, info, actions) {
        const record = data.collections.find(c => c.resultId === result.id && c.state !== 'deleted');
        const job = record && data.jobs.find(j => j.type === 'collect' && j.context.collectionId === record.id);
        const status = collectionErrors.get(result.id) || (collecting.has(result.id) ? '正在提交收藏…' : record ?
            record.state === 'ready' ? '已收藏到网盘' : `收藏到网盘：${states[record.state] || record.state}${job?.progress ? ' · ' + job.progress + '%' : ''}${job?.message ? ' · ' + job.message : ''}` : '');
        if (status) { const line = el('small', status, 'ml-collection-progress'); line.setAttribute('role', 'status'); info.append(line); }
        if (record?.state === 'ready' && record.file) {
            const link = el('a', '▤', 'ml-disk-link'); link.title = '在网盘中定位收藏文件'; link.setAttribute('aria-label', link.title);
            const path = record.file.path ?? record.location.path;
            const params = new URLSearchParams({ disk_account: record.file.userId, disk_space: record.file.diskSpace || '',
                disk_path: path || '', disk_file: record.file.fileId });
            link.href = '/disk?' + params; link.target = '_blank'; link.rel = 'noopener'; actions.append(link);
        }
        return record;
    }
    function renderResults() {
        for(const line of $('ml-results')?.querySelectorAll('[data-compression-job]')||[]){const job=data.jobs.find(j=>j.id===line.dataset.compressionJob);if(job)line.textContent=compressionStatus(job);}
        if($('ml-results')?.querySelector('textarea[data-dirty="1"]')) {
            for(const job of data.jobs.filter(j=>j.type==='transcode')){const box=$('ml-results').querySelector('[data-result-id="'+job.context.resultId+'"]');if(!box)continue;
                let line=box.querySelector('[data-compression-job="'+job.id+'"]');if(!line){line=el('p');line.dataset.compressionJob=job.id;box.append(line);}line.textContent=compressionStatus(job);
                const result=data.results.find(r=>r.id===job.context.resultId);if(result&&(data.compressions||[]).some(v=>v.resultId===result.id&&v.cacheReady)&&!box.querySelector('.ml-compression-view'))box.append(button('看压缩版',()=>compressionViewer(result),'ml-compression-view'));
            }return;
        }
        const area = $('ml-results'); if (!area) return; const order = $('ml-frame-order')?.value, unsaved = $('ml-frame-unsaved')?.checked;
        const results = data.results.filter(r => !r.reference && r.sessionId === sessionId && (!unsaved || !r.savedId)).sort((a, b) => order === 'created' ? b.extractedAt - a.extractedAt : (a.actualMs ?? a.startMs) - (b.actualMs ?? b.startMs));
        area.replaceChildren();
        for (const job of data.jobs.filter(j => j.type === 'clip' && j.context.sessionId === sessionId && !data.results.some(r => r.id === j.id)).sort((a, b) => b.createdAt - a.createdAt)) {
            const box = el('article', undefined, 'ml-frame ml-pending-clip'), info = el('div'); box.dataset.jobId = job.id;
            info.append(el('strong', '🎞 候选 Clip'), el('p', time(job.context.start * 1000) + '～' + time(job.context.end * 1000)), badge(job.state));
            const meter = document.createElement('progress'); meter.max = 100; meter.value = job.progress || 0; meter.className = 'ml-progress';
            info.append(meter, el('small', (job.progress || 0) + '%', 'ml-muted'));
            if (job.error) info.append(el('p', job.message || job.error, 'ml-result-time'));
            const actions = el('div', undefined, 'ml-actions');
            if (['queued', 'running'].includes(job.state)) actions.append(button('取消', async () => { rememberRecord('jobs', await api('/jobs/' + job.id + '/cancel', json('POST'))); renderResults(); }));
            if (['failed', 'cancelled', 'interrupted'].includes(job.state)) actions.append(button('重试', async () => { rememberRecord('jobs', await api('/jobs/' + job.id + '/retry', json('POST'))); renderResults(); }));
            info.append(actions); box.append(info); area.append(box);
        }
        for (const result of results) {
            const box = el('article', undefined, 'ml-frame' + (selection.has(result.id) ? ' selected' : '')), info = el('div'); box.dataset.resultId = result.id;
            if (result.cacheReady && result.kind === 'image') { const image = document.createElement('img'); image.loading = 'lazy'; image.src = root + '/cache/' + result.cacheId; image.alt = '实际画面 ' + time(result.actualMs); box.append(image); }
            else box.append(el('p', result.kind === 'clip' ? '🎞 Clip' : '缓存已清理', 'ml-muted'));
            const chosen = input('', 'checkbox'); chosen.checked = selection.has(result.id); chosen.onchange = () => { chosen.checked ? selection.add(result.id) : selection.delete(result.id); box.classList.toggle('selected', chosen.checked); };
            info.append(label(result.kind === 'image' ? time(result.actualMs) : time(result.startMs) + '～' + time(result.endMs), chosen));
            if (result.kind === 'image') info.append(el('p', `请求 ${time(result.requestedMs)} · 实际 ${time(result.actualMs)}${result.duplicateIds?.length ? ' · 同时刻已有记录' : ''}`, 'ml-result-time'));
            info.append(el('div', date(result.extractedAt) + (result.savedId ? ' · 已收藏' : ' · 未收藏'), 'ml-muted'));
            const actions = el('div', undefined, 'ml-actions');
            const collection = renderCollectionProgress(result, info, actions);
            if (result.cacheReady) actions.append(button('查看', () => { const media = document.createElement(result.kind === 'image' ? 'img' : 'video'); media.className = 'ml-preview'; media.src = root + '/cache/' + result.cacheId; if (result.kind === 'clip') media.controls = true; dialog('候选资源', media); }),
                button(collection?.state === 'ready' ? '已收藏' : collection && ['queued', 'transferring'].includes(collection.state) ? '收藏中…' : '收藏', async () => {
                    if (collection && ['failed', 'cancelled', 'interrupted'].includes(collection.state)) {
                        const job = data.jobs.find(j => j.type === 'collect' && j.context.collectionId === collection.id);
                        if (job) { rememberRecord('jobs', await api('/jobs/' + job.id + '/retry', json('POST'))); rememberRecord('collections', { ...collection, state: 'queued' }); renderResults(); return; }
                    }
                    await collectCandidate(result.id);
                }));
            if (collection && ['ready', 'queued', 'transferring'].includes(collection.state) || collecting.has(result.id)) actions.querySelectorAll('button').forEach(node => { if (node.textContent !== '查看') node.disabled = true; });
            if(result.kind==='clip'){
                const note=el('textarea');note.value=result.remark||'';note.maxLength=65535;note.placeholder='Clip 备注';note.oninput=()=>{note.dataset.dirty='1';};
                info.append(el('small','修改备注后点击保存，下载和收藏使用已保存备注','ml-muted'),note,button('保存备注',async()=>{const saved=await api('/results/'+result.id,json('PATCH',{remark:note.value,version:result.version}));rememberRecord('results',saved);note.dataset.dirty='';notice('Clip 备注已保存');renderResults();}));
                if(result.cacheReady){const download=el('a','⇩','ml-disk-link');download.href=root+'/results/'+result.id+'/download';download.title='下载 Clip';actions.append(download,button('压缩转码',()=>transcodeDialog(result)));}
                const variants=(data.compressions||[]).filter(v=>v.resultId===result.id&&v.cacheReady);
                if(variants.length)actions.append(button('看压缩版',()=>compressionViewer(result)));
                for(const job of data.jobs.filter(j=>j.type==='transcode'&&j.context.resultId===result.id)){const jobLine=el('p', compressionStatus(job));jobLine.dataset.compressionJob=job.id;info.append(jobLine);if(['queued','running'].includes(job.state))info.append(button('取消转码',async()=>{rememberRecord('jobs',await api('/jobs/'+job.id+'/cancel',json('POST')));renderResults();}));}
            }
            if (result.kind === 'image') actions.append(button('相似度', () => compareDialog(result)));
            info.append(actions); box.append(info); area.append(box);
        }
    }
    function transcodeDialog(result){const body=el('div',undefined,'ml-stack'),width=input('','number'),height=input('','number'),crf=input('28','number'),preset=select(['','ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow','placebo'].map(value=>[value,value||'默认']));body.append(label('目标宽度（可选）',width),label('目标高度（可选）',height),label('CRF',crf),label('preset（可选）',preset));
        dialog('压缩转码',body,[button('提交转码',async()=>{const job=await api('/results/'+result.id+'/transcode',json('POST',{width:width.value,height:height.value,crf:crf.value,preset:preset.value}));rememberRecord('jobs',job);$('ml-dialog').close();renderResults();notice('压缩任务已排队，Clip 卡片中可查看进度');},'primary')]);}
    function compressionViewer(result){const wrap=el('div',undefined,'ml-compression-viewer'),left=el('aside'),right=el('section'),top=el('div',undefined,'ml-compression-toolbar');
        top.append(button('+ 以其它参数转码',()=>transcodeDialog(result)));left.append(top);
        const choose=variant=>{const video=el('video');video.controls=true;video.className='ml-preview';video.src=root+'/cache/'+variant.cacheId;video.onerror=()=>{right.append(el('p','当前浏览器可能不支持此 HEVC/MKV 压缩版本，可下载后使用兼容播放器打开。'));};
            const download=el('a','⇩ 下载此压缩版');download.href=video.src;download.download='clip-'+variant.id+'.mkv';
            const details=el('pre',JSON.stringify({参数:variant.params,结果:variant.quality,源大小:variant.sourceBytes,完成时间:date(variant.completedAt)},null,2));right.replaceChildren(video,download,details);};
        const variants=(data.compressions||[]).filter(v=>v.resultId===result.id&&v.cacheReady);
        for(const variant of variants){const entry=button('CRF '+variant.params.crf+' · '+(variant.params.width||'自动')+'×'+(variant.params.height||'自动'),()=>choose(variant));const img=el('img');img.src=root+'/cache/'+variant.thumbnailCacheId;img.alt='压缩结果缩略图';entry.append(img);left.append(entry);}wrap.append(left,right);dialog('Clip 压缩版本',wrap);if(variants.length)choose(variants[0]);}
    async function compareDialog(result) {
        const body = el('div', undefined, 'ml-stack'), against = select([['session', '当前会话'], ['video', '同源视频全部会话'], ['collection', '正式收藏画面'], ['references', '临时参考图集']]);
        const threshold = input(80, 'number'), matches = el('div', undefined, 'ml-grid'); body.append(label('比较范围', against), label('感知哈希初筛阈值（0～100）', threshold), el('p', '先比较感知哈希，再比较归一化灰度像素。近似度是提示，不是人物识别或自动删除决定。'), matches);
        const files = input('', 'file'); files.accept = 'image/*'; files.multiple = true;
        files.onchange = async () => { try { for (const file of files.files) await api('/references', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Media-Name': encodeURIComponent(file.name), 'X-Media-Size': String(file.size) }, body: file }); notice('参考图已接收，处理队列完成后可比较'); } catch (e) { notice(e.message, true); } }; body.append(label('上传参考图片', files));
        dialog('相似画面比较', body, [button('比较', async () => { const value = await api('/results/' + result.id + '/compare', json('POST', { against: against.value, threshold: Number(threshold.value) })); matches.replaceChildren();
            for (const match of value.matches) { const box = card('', ''), image = document.createElement('img'); image.className = 'ml-preview';
                if (match.collectionId) image.src = root + '/files/' + match.collectionId + '?kind=collection'; else if (match.cacheReady) image.src = root + '/cache/' + match.cacheId;
                if (image.src) box.append(image); else box.append(el('p', '缓存已清理，比较记录保留'));
                box.append(el('p', `${match.exact ? '正文完全相同' : '灰度像素 ' + match.score + '% · 感知哈希 ' + match.hashScore + '%'} · ${time(match.actualMs)}`)); matches.append(box); }
            if (!value.matches.length) matches.append(el('p', '未发现达到阈值的记录。')); }, 'primary')]);
    }
    function renderCollection() {
        const box = card('收藏资源库', '正式收藏独立保存；失效引用保留来源和分类，明确显示当前状态。'), query = input(collectionQuery), entity = select([['', '全部人物 / 组织 / 标签'], ...data.entities.filter(e => !e.mergedInto).map(e => [e.id, e.name])], collectionEntity); query.placeholder = '搜索名称、来源和标签';
        const grid = el('div', undefined, 'ml-grid'), filtering = () => {
            collectionQuery = query.value; collectionEntity = entity.value; grid.replaceChildren();
            for (const record of data.collections.filter(c => c.state !== 'deleted' && (!entity.value || c.entities.includes(entity.value)))) {
                const names = record.entities.map(id => data.entities.find(e => e.id === id)?.name || '').join(' '); if (query.value && !(record.name + ' ' + names + ' ' + JSON.stringify(record.source)).toLowerCase().includes(query.value.toLowerCase())) continue;
                const entry = card('', ''), image = document.createElement(record.kind === 'image' ? 'img' : 'video'); image.className = 'ml-preview'; image.preload = 'none'; if (record.available) image.src = root + '/files/' + record.id + '?kind=collection'; if (record.kind !== 'image') image.controls = true;
                entry.append(image, el('div', record.name, 'ml-item-name'), badge(record.state), el('p', (record.external ? '外部文件引用' : '独立正式收藏') + ' · ' + date(record.collectedAt)), el('p', names || '未设置分类'));
                if (!record.available && record.state === 'ready') entry.append(badge('unavailable', '源文件不存在或授权不可用'));
                entry.append(button('详情与关联', () => collectionDetails(record))); grid.append(entry);
            }
        }; query.oninput = filtering; entity.onchange = filtering; box.append(el('div', undefined, 'ml-row'), query, entity, grid); filtering(); return box;
    }
    function collectionDetails(record) {
        const body = el('div', undefined, 'ml-stack'), ids = new Set(record.entities);
        body.append(el('p', record.external ? '外部引用：不会删除原网盘文件。' : '正式收藏：不随源文件到期或会话清理删除。'));
        for (const entity of data.entities.filter(e => !e.mergedInto)) { const chosen = input('', 'checkbox'); chosen.checked = ids.has(entity.id); chosen.onchange = () => chosen.checked ? ids.add(entity.id) : ids.delete(entity.id); body.append(label(entity.name + ' · ' + ({ person: '人物', organization: '组织', tag: '标签' })[entity.entityKind], chosen)); }
        body.append(el('pre', JSON.stringify({ file: record.file, source: record.source, importId: record.importId }, null, 2)));
        dialog(record.name, body, [button('保存关联', async () => { await api('/collections/' + record.id + '/entities', json('PUT', { entities: [...ids] })); $('ml-dialog').close(); await refresh(true); }, 'primary'),
            button('移除收藏记录', async () => { if (!confirm('仅移除收藏记录，网盘文件保留。确认？')) return; await api('/collections/' + record.id, json('DELETE')); $('ml-dialog').close(); await refresh(true); }, 'danger'),
            ...(!record.external && record.state === 'ready' ? [button('删除收藏及其网盘文件', async () => { if (!confirm('将删除此收藏和本系统持有的网盘逻辑文件；其它内容引用不受影响。确认？')) return; await api('/collections/' + record.id, json('DELETE', { deleteFile: true })); $('ml-dialog').close(); await refresh(true); }, 'danger')] : [])]);
    }
    function renderEntities() {
        const box = card('人物、组织与标签', '一个资源可关联多个实体；同类型名称或别名冲突会被拒绝。人物组织关系可以保存起止时间。'), actions = el('div', undefined, 'ml-actions');
        for (const [kind, text] of [['person', '新建人物'], ['organization', '新建组织'], ['tag', '新建标签']]) actions.append(button(text, () => editEntity({ entityKind: kind }))); box.append(actions);
        const grid = el('div', undefined, 'ml-grid'); for (const entity of data.entities.filter(e => !e.mergedInto)) { const entry = card(entity.name, entity.description); entry.append(el('p', `${entity.entityKind} · 别名：${entity.aliases.join('、') || '无'}`), button('编辑', () => editEntity(entity))); grid.append(entry); } box.append(grid);
        const people = select(data.entities.filter(e => e.entityKind === 'person').map(e => [e.id, e.name])), org = select(data.entities.filter(e => e.entityKind === 'organization').map(e => [e.id, e.name])), from = input('', 'date'), to = input('', 'date');
        const relation = card('人物与组织历史关系'); relation.append(label('人物', people), label('组织', org), label('加入日期', from), label('离开日期（可空）', to), button('保存关系', async () => { await api('/relations', json('POST', { personId: people.value, organizationId: org.value, from: from.value, to: to.value })); await refresh(true); }));
        for (const link of data.relations || []) relation.append(el('p', `${data.entities.find(e => e.id === link.personId)?.name || '人物'} ⇔ ${data.entities.find(e => e.id === link.organizationId)?.name || '组织'} · ${link.from || '日期未指定'} ～ ${link.to || '当前'}`)); box.append(relation); return box;
    }
    function editEntity(entity) {
        const body = el('div', undefined, 'ml-stack'), name = input(entity.name || ''), aliases = input(entity.aliases?.join(',') || ''), description = document.createElement('textarea'); description.value = entity.description || '';
        body.append(label('名称', name), label('别名（逗号隔开）', aliases), label('说明', description));
        dialog(entity.id ? '编辑实体' : '新建实体', body, [button('保存', async () => { await api('/entities' + (entity.id ? '/' + entity.id : ''), json(entity.id ? 'PATCH' : 'POST', { name: name.value, aliases: aliases.value.split(/[,，]/).map(s => s.trim()).filter(Boolean), entityKind: entity.entityKind, description: description.value, version: entity.version })); $('ml-dialog').close(); await refresh(true); }, 'primary')]);
    }
    function renderStatus() {
        const box = el('div'), stats = el('div', undefined, 'ml-stats');
        for (const [title, value] of [['导入资源', data.imports.length], ['后台任务', data.jobs.filter(j => ['queued', 'running'].includes(j.state)).length], ['本地缓存', bytes(data.caches.reduce((n, c) => n + c.size, 0))], ['失败任务', data.jobs.filter(j => j.state === 'failed').length]]) { const entry = card(title); entry.append(el('strong', String(value))); stats.append(entry); } box.append(stats);
        const jobs = card('后台任务列表', '导入、网盘转存、取帧、裁切和收藏任务由独立队列执行；关闭浏览器后可继续。'), wrap = el('div', undefined, 'ml-table-wrap'), table = el('table', undefined, 'ml-table'), head = el('tr');
        ['任务类型 / 编号', '状态与详情', '进度', '创建时间', '操作'].forEach(text => head.append(el('th', text))); table.append(head);
        for (const job of data.jobs) { const row = el('tr'); row.append(el('td', job.type + ' · ' + job.id.slice(0, 8))); const state = el('td'); state.append(badge(job.state)); if (job.error) state.append(el('p', `${job.message} [${job.error}]`)); row.append(state);
            const progress = el('td'), meter = document.createElement('progress'); meter.className = 'ml-progress'; meter.max = 100; meter.value = job.progress || 0; progress.append(meter, el('small', (job.progress || 0) + '%')); row.append(progress, el('td', date(job.createdAt)));
            const actions = el('td'); if (['running', 'queued'].includes(job.state)) actions.append(button('取消', async () => { await api('/jobs/' + job.id + '/cancel', json('POST')); await refresh(true); }, 'danger'));
            else if (['failed', 'cancelled', 'interrupted'].includes(job.state)) actions.append(button('重试', async () => { await api('/jobs/' + job.id + '/retry', json('POST')); await refresh(true); }));
            actions.append(button('详情', () => dialog('后台任务详情', el('pre', JSON.stringify(job, null, 2))))); row.append(actions); table.append(row); }
        wrap.append(table); jobs.append(wrap, button('清理到期与超量缓存', async () => { const value = await api('/cleanup', json('POST')); await refresh(true); notice(`已清理 ${value.removed} 个本地缓存和 ${value.expired} 个过期工作区源文件`); }),
            button('清理全部未使用临时缓存', async () => { if (!confirm('清理未被任务保护的片段、候选和参考图缓存；帧日志及正式收藏保留。确认？')) return; await api('/cleanup', json('POST', { all: true })); await refresh(true); }, 'danger')); box.append(jobs);
        const events = card('最近事件 / 告警'); for (const event of data.events.slice(0, 50)) events.append(el('p', `${date(event.createdAt)} · ${event.message}`)); box.append(events); return box;
    }
    function render() { disposePlayer(); disposePlayer = () => {}; const renderers = { infra: renderInfra, imports: renderImports, sessions: renderSessions, collection: renderCollection, entities: renderEntities, status: renderStatus }; $('ml-main').replaceChildren(renderers[tab]()); }
    document.querySelectorAll('[data-tab]').forEach(node => node.onclick = () => changeTab(node.dataset.tab));
    $('ml-dialog-close').onclick = () => $('ml-dialog').close();
    $('ml-dialog').addEventListener('close', () => $('ml-dialog-body').querySelectorAll('video').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); }));
    $('ml-help').onclick = async () => { try { const response = await fetch(root + '/help'); if (!response.ok) throw Error('帮助文档加载失败'); const body = el('div', undefined, 'ml-help'); const text = await response.text(); body.innerHTML = DOMPurify.sanitize(marked.parse(text)); dialog('媒体收藏使用指南', body); } catch (e) { notice(e.message, true); } };
    refresh(true).then(() => { if (data.config?.workspace && data.config?.collection) changeTab('imports'); else changeTab('infra'); }).catch(error => notice(error.message, true));
    setInterval(() => { if (!document.hidden) refresh().catch(error => notice(error.message, true)); }, 3000);
})();
