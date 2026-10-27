(() => {
    'use strict';
    const $ = id => document.getElementById(id), apiRoot = '/api/system-backup';
    let state = null, mode = '', path = '', loading = false, selectionVersion = 0, polling = null, actionCount = 0;
    const t = (source, ...values) => (window.TunnelI18n?.t(source) || source).replace(/\{(\d+)\}/g, (_all, index) => String(values[Number(index)] ?? ''));
    const labels = { snapshotting: '正在创建快照', uploading: '正在保存到网盘', cancelling: '正在取消', cancelled: '已取消', failed: '失败，可重试', interrupted: '进程中断，可重试', completed: '备份完成', discarded: '已释放本机快照' };
    const text = (tag, value, className = '') => { const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element; };
    const notice = value => { $('sb-notice').textContent = value; };
    const bytes = value => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : value < 1073741824 ? `${(value / 1048576).toFixed(1)} MB` : `${(value / 1073741824).toFixed(2)} GB`;
    async function api(route, options = {}) {
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
        try { const response = await fetch(apiRoot + route, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...options.headers } });
            const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data;
        } finally { clearTimeout(timeout); }
    }
    const action = (label, handler) => { const button = text('button', t(label)); button.onclick = async () => { button.disabled = true; actionCount++; try { await handler(); } catch (error) { notice(t('操作未完成：{0}', error.message)); } finally { button.disabled = false; actionCount--; if (state) render(); } }; return button; };
    function targetText(target) { return target ? `${target.userName} / ID ${target.loginId} → ${target.partitionName} → /${target.folderPath}` : t('尚未设置备份位置'); }
    function render() {
        for (const name of ['full', 'core']) { $('sb-target-' + name).textContent = targetText(state.config[name]); document.querySelector(`[data-start="${name}"]`).disabled = !state.config[name] || Boolean(state.active); }
        const jobs = $('sb-jobs');
        if (!state.jobs.length) { if (!jobs.children.length) jobs.append(text('p', t('尚无备份任务。'), 'sb-muted')); return; }
        jobs.querySelector('p.sb-muted')?.remove();
        for (const job of state.jobs) {
            let card = jobs.querySelector(`[data-job-id="${job.id}"]`);
            if (!card) { card = text('article', '', 'sb-job'); card.dataset.jobId = job.id;
                for (const name of ['heading', 'target', 'count', 'current', 'detail', 'error']) { const row = text('div', '', name === 'heading' ? 'sb-job-title' : name === 'error' ? 'sb-job-details sb-error' : 'sb-job-details'); row.dataset.row = name; card.append(row); }
                card.append(document.createElement('progress'), text('div', '', 'sb-actions')); jobs.prepend(card); }
            const row = name => card.querySelector(`[data-row="${name}"]`);
            row('heading').replaceChildren(text('span', `${t(job.mode === 'full' ? '全量' : '核心')} · /${job.folder}`), text('span', t(job.status==='completed'&&job.skipped?.length?'备份完成（有跳过项）':labels[job.status] || job.status), 'sb-status'));
            row('target').textContent = targetText(job.target);
            row('count').textContent = t('{0} · {1} / {2} 个文件 · {3} / {4}', new Date(job.createdAt).toLocaleString(), job.completedFiles, job.totalFiles, bytes(job.completedBytes), bytes(job.totalBytes));
            const progress = card.querySelector('progress'); progress.max = Math.max(1, job.totalBytes); progress.value = job.completedBytes; if (job.status === 'snapshotting') progress.removeAttribute('value');
            row('current').textContent = job.currentFile ? t('当前文件：{0}', job.currentFile) : '';
            row('detail').textContent = (job.currentProgress ? `${job.currentProgress.percent}% · ${job.currentProgress.detail || job.currentProgress.phase}` : '') +
                (job.skipped?.length ? '\n' + t('已跳过 {0} 项（读取权限受限）：', job.skipped.length) + '\n' + job.skipped.map(item => `${item.name} [${item.code}]`).join('\n') : '');
            row('error').textContent = job.error ? t('未完成：{0}。已完成的文件不会重复保存。', job.error) : job.cleanupWarning ? t('网盘备份已完成，本机快照清理失败：{0}', job.cleanupWarning) : '';
            const actions = card.querySelector('.sb-actions'), signature = `${state.active === job.id}:${job.status}`;
            if (actions.dataset.signature === signature || actionCount) continue; actions.dataset.signature = signature; actions.replaceChildren();
            if (state.active === job.id) actions.append(action('取消备份', async () => { await api(`/jobs/${job.id}/cancel`, { method: 'POST' }); await refresh(); }));
            if (['failed', 'interrupted', 'cancelled'].includes(job.status)) {
                actions.append(action('重试', async () => { await api(`/jobs/${job.id}/retry`, { method: 'POST' }); await refresh(); }));
                actions.append(action('释放本机快照', async () => { if (!confirm(t('释放后不能继续这次备份，网盘中已保存的文件会保留。确定释放？'))) return; await api(`/jobs/${job.id}/discard`, { method: 'POST' }); await refresh(); }));
            }
        }
    }
    async function refresh() { if (loading) return; loading = true; try { state = await api('/state'); render(); for (const button of document.querySelectorAll('[data-config]')) button.disabled = false; } catch (error) { notice(t('读取备份状态失败：{0}', error.message)); } finally { loading = false; } }
    async function directories(resetPartition = false) {
        const version = ++selectionVersion; $('sb-save').disabled = true; $('sb-directory-status').textContent = t('正在加载分区与目录…'); $('sb-directories').replaceChildren();
        const params = new URLSearchParams({ userId: $('sb-user').value, path }); if (!resetPartition && $('sb-partition').value) params.set('partitionId', $('sb-partition').value);
        try {
            const result = await api('/targets?' + params); if (version !== selectionVersion) return;
            $('sb-partition').replaceChildren(...result.partitions.map(item => new Option(item.displayName, item.id))); $('sb-partition').value = result.selected;
            path = result.path; $('sb-path').value = '/' + path;
            for (const folder of result.directories) $('sb-directories').append(action('▱ ' + folder.name, async () => { path = folder.path; await directories(); }));
            $('sb-directory-status').textContent = t(result.directories.length ? '点击目录继续进入，或保存当前位置。' : '当前目录没有子目录。'); $('sb-save').disabled = false;
        } catch (error) { if (version === selectionVersion) $('sb-directory-status').textContent = t('目录读取失败：{0}', error.message); }
    }
    for (const button of document.querySelectorAll('[data-config]')) button.onclick = async () => {
        if (!state) return; mode = button.dataset.config; const target = state.config[mode]; $('sb-config-title').textContent = t(mode === 'full' ? '全量备份位置' : '核心备份位置');
        $('sb-user').replaceChildren(...state.users.map(user => new Option(`${user.name || user.username || user.telegramId} / ID ${user.telegramId || user.username || user.id}`, user.id)));
        if (target) $('sb-user').value = target.userId; $('sb-partition').replaceChildren(); if (target) $('sb-partition').append(new Option(target.partitionName, target.partitionId)); path = target?.folderPath || '';
        $('sb-config').showModal(); if (!state.users.length) { $('sb-directory-status').textContent = t('系统中没有网盘账号，请先添加备份专用账号。'); $('sb-save').disabled = true; return; } await directories(!target);
    };
    for (const button of document.querySelectorAll('[data-start]')) button.onclick = async () => { if (!state) return; button.disabled = true; notice(''); try { const requestId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `backup-${Date.now()}-${Math.random().toString(36).slice(2)}`; await api('/jobs', { method: 'POST', body: JSON.stringify({ mode: button.dataset.start, requestId }) }); await refresh(); } catch (error) { notice(t('备份未能开始：{0}', error.message)); await refresh(); } };
    $('sb-user').onchange = () => { path = ''; directories(true); }; $('sb-partition').onchange = () => { path = ''; directories(); };
    $('sb-root').onclick = () => { path = ''; directories(); }; $('sb-parent').onclick = () => { path = path.split('/').slice(0, -1).join('/'); directories(); };
    $('sb-close').onclick = $('sb-cancel').onclick = () => { selectionVersion++; $('sb-config').close(); };
    $('sb-form').onsubmit = async event => { event.preventDefault(); $('sb-save').disabled = true; try { await api('/config/' + mode, { method: 'PUT', body: JSON.stringify({ userId: $('sb-user').value, partitionId: $('sb-partition').value, folderPath: path }) }); $('sb-config').close(); await refresh(); notice(t('备份位置已保存。')); } catch (error) { notice(t('保存位置失败：{0}', error.message)); } finally { $('sb-save').disabled = false; } };
    $('sb-refresh').onclick = refresh;
    for (const button of document.querySelectorAll('[data-config],[data-start]')) button.disabled = true;
    refresh(); polling = setInterval(() => { if (!document.hidden) refresh(); }, 2500);
    window.addEventListener('pagehide', () => { clearInterval(polling); polling = null; });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (!polling) polling = setInterval(refresh, 2500); refresh(); } });
})();
