'use strict';
(function () {
    const states = new Map(), POLL_INTERVAL = 1200;
    let activeDialog = null;
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const render = state => { state.render?.(); state.renderPopover?.(); };
    function startDownload(state) {
        const download = document.createElement('a'); download.href = state.downloadUrl; download.download = state.name;
        document.body.append(download); download.click(); download.remove();
    }
    const timeText = seconds => {
        const value = Math.max(0, Math.floor(Number(seconds) || 0));
        return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
    };
    function progressMessage(result) {
        if (result.status === 'queued') return '已加入后端转码队列，等待处理…';
        if (result.status === 'completed') return '音轨修正版已就绪，可预览或下载。';
        if (result.status === 'failed') return '音轨修正失败：' + (result.error || '未知错误');
        const details = [result.phase || '服务器正在生成音轨修正版'];
        if (Number.isFinite(result.progress)) details.push(Math.round(result.progress) + '%');
        if (result.durationSeconds) details.push(timeText(result.outTimeSeconds) + '/' + timeText(result.durationSeconds));
        if (result.speed) details.push(result.speed);
        if (result.frame) details.push('frame ' + result.frame);
        return details.join(' · ');
    }
    function applyResult(state, result) {
        Object.assign(state, {
            jobId: result.jobId || state.jobId, statusUrl: result.statusUrl || state.statusUrl,
            downloadUrl: result.downloadUrl || state.downloadUrl, previewUrl: result.previewUrl || state.previewUrl,
            name: result.name || state.name, status: result.status || state.status, progress: result.progress
        });
        if (result.status === 'completed') state.hasResult = true;
        state.message = progressMessage(result);
    }
    function beginPolling(state, request) {
        if (state.polling || !state.statusUrl) return;
        state.polling = true;
        state.pollPromise = (async () => {
            while (state.status === 'queued' || state.status === 'processing') {
                await wait(POLL_INTERVAL);
                try { applyResult(state, await request(state.statusUrl)); }
                catch (error) { state.status = 'failed'; state.message = '音轨修正状态读取失败：' + error.message; }
                render(state);
            }
        })().finally(() => { state.polling = false; state.pollPromise = null; render(state); });
    }
    function openRepair(state, task, root, request) {
        if (activeDialog?.open) { activeDialog.focus(); return; }
        const modal = document.createElement('dialog'); modal.className = 'audio-repair-dialog'; modal.setAttribute('aria-label', '修正音轨');
        const header = document.createElement('header'), title = document.createElement('h2'), close = document.createElement('button');
        title.textContent = '修正音轨'; close.type = 'button'; close.textContent = '×'; close.className = 'danger'; close.setAttribute('aria-label', '关闭音轨修正');
        close.onclick = () => modal.close(); header.append(title, close);
        const body = document.createElement('div'); body.className = 'audio-repair-body';
        const description = document.createElement('p'); description.textContent = '修正截取视频后的音轨偏移，另存修正版，保留原文件。';
        const actions = document.createElement('div'); actions.className = 'audio-repair-actions';
        const execute = document.createElement('button'), preview = document.createElement('button'), download = document.createElement('button');
        for (const button of [execute, preview, download]) button.type = 'button';
        execute.className = 'primary'; preview.textContent = '预览'; download.textContent = '下载'; actions.append(execute, preview, download);
        const status = document.createElement('p'); status.className = 'audio-repair-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        const progress = document.createElement('progress'); progress.max = 100; progress.className = 'audio-repair-progress';
        const video = document.createElement('video'); video.className = 'audio-repair-video'; video.controls = true; video.playsInline = true; video.preload = 'metadata'; video.hidden = true;
        const stopPreview = () => { video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true; };
        preview.onclick = () => {
            if (state.status !== 'completed' || state.submitting) return;
            video.src = state.previewUrl || state.downloadUrl + '?inline=1'; video.hidden = false;
            video.play()?.catch(() => {});
        };
        download.onclick = () => { if (state.status === 'completed' && !state.submitting) startDownload(state); };
        execute.onclick = async () => {
            if (state.submitting || ['queued','processing'].includes(state.status)) return;
            if (!confirm('服务器将重新编码完整音视频，修正截取片段后的音轨偏移。修正版另存，原文件保留。' + (state.hasResult ? '本次将重新生成修正版。' : '') + '\n是否继续？')) return;
            state.submitting = true; state.revision++; stopPreview();
            state.message = '正在提交后端转码队列…'; render(state);
            try {
                applyResult(state, await request(root + '/tasks/' + encodeURIComponent(task.id) + '/audio-repair', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: state.hasResult })
                }));
                if (state.status !== 'completed') beginPolling(state, request);
            } catch (error) { state.status = 'failed'; state.message = '音轨修正失败：' + error.message; }
            finally { state.submitting = false; render(state); }
        };
        state.renderPopover = () => {
            const running = state.submitting || ['queued','processing'].includes(state.status), ready = state.status === 'completed' && !running;
            execute.textContent = state.hasResult ? '重新修正音轨' : '执行音轨修正'; execute.disabled = running;
            preview.hidden = download.hidden = !state.hasResult; preview.disabled = download.disabled = !ready;
            status.textContent = state.message || (state.inspecting ? '正在检查已有修正版…' : '点击“执行音轨修正”开始处理。');
            progress.hidden = !running; progress.removeAttribute('value'); if (Number.isFinite(state.progress)) progress.value = state.progress;
            modal.setAttribute('aria-busy', String(running));
        };
        body.append(description, actions, status, progress, video); modal.append(header, body); document.body.append(modal);
        activeDialog = modal; state.renderPopover();
        modal.addEventListener('close', () => { stopPreview(); state.renderPopover = null; if (activeDialog === modal) activeDialog = null; modal.remove(); }, { once: true });
        modal.showModal();
    }
    function create(task, root, request) {
        const key = root + ':' + task.id;
        if (!states.has(key)) states.set(key, { submitting: false, inspecting: false, lastInspectedAt: 0, revision: 0, hasResult: false, status: 'idle', message: '', jobId: '', statusUrl: '', downloadUrl: '', previewUrl: '', name: '', progress: null, polling: false });
        const state = states.get(key), panel = document.createElement('div'); panel.className = 'audio-repair-panel';
        const button = document.createElement('button'); button.type = 'button'; button.textContent = '修正音轨'; button.setAttribute('aria-haspopup', 'dialog');
        const status = document.createElement('span'); status.className = 'audio-repair-summary'; status.setAttribute('role', 'status');
        button.onclick = () => openRepair(state, task, root, request);
        state.render = () => { status.textContent = state.message; button.classList.toggle('is-running', state.submitting || ['queued','processing'].includes(state.status)); };
        render(state);
        if (['queued','processing'].includes(state.status)) beginPolling(state, request);
        else if (state.status === 'idle' && !state.inspecting && Date.now() - state.lastInspectedAt >= 10000) {
            state.inspecting = true; const revision = state.revision;
            request(root + '/tasks/' + encodeURIComponent(task.id) + '/audio-repair/status').then(result => {
                if (revision !== state.revision) return;
                applyResult(state, result); if (['queued','processing'].includes(result.status)) beginPolling(state, request);
            }).catch(() => {}).finally(() => { state.inspecting = false; state.lastInspectedAt = Date.now(); render(state); });
        }
        panel.append(button, status); return panel;
    }
    window.AudioTrackRepair = { create, busy: () => Boolean(activeDialog?.open) || [...states.values()].some(state => state.submitting) };
})();
