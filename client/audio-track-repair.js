'use strict';
(function () {
    const states = new Map();
    const POLL_INTERVAL = 1200;
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    function startDownload(state, result = state) {
        const download = document.createElement('a'); download.href = result.downloadUrl; download.download = result.name;
        document.body.append(download); download.click(); download.remove();
    }
    const timeText = seconds => {
        const value = Math.max(0, Math.floor(Number(seconds) || 0));
        return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
    };
    function progressMessage(result) {
        if (result.status === 'queued') return '已加入后端转码队列，等待处理…';
        if (result.status === 'completed') return result.reused ? '修正版缓存可直接下载。' : '音轨修正版处理完成，可直接下载。';
        if (result.status === 'failed') return '音轨修正失败：' + (result.error || '未知错误');
        const details = [result.phase || '服务器正在生成音轨修正版'];
        if (Number.isFinite(result.progress)) details.push(`${Math.round(result.progress)}%`);
        if (result.durationSeconds) details.push(`${timeText(result.outTimeSeconds)}/${timeText(result.durationSeconds)}`);
        if (result.speed) details.push(result.speed);
        if (result.frame) details.push(`frame ${result.frame}`);
        return details.join(' · ');
    }
    function applyResult(state, result) {
        Object.assign(state, {
            jobId:result.jobId || state.jobId, statusUrl:result.statusUrl || state.statusUrl,
            downloadUrl:result.downloadUrl || state.downloadUrl, name:result.name || state.name,
            status:result.status || state.status, progress:result.progress,
            durationSeconds:result.durationSeconds || 0, outTimeSeconds:result.outTimeSeconds || 0,
            speed:result.speed || '', frame:result.frame || 0, phase:result.phase || ''
        });
        state.message = progressMessage(result);
    }
    function updateView(state, button, checkbox, status, progress) {
        const running = state.status === 'queued' || state.status === 'processing';
        button.disabled = state.submitting || running;
        checkbox.disabled = state.submitting || running;
        button.classList.toggle('is-ready', state.status === 'completed' && !state.force);
        status.textContent = state.message;
        const showProgress = running && Number.isFinite(state.progress);
        progress.hidden = !showProgress;
        if (showProgress) progress.value = state.progress;
    }
    function beginPolling(state, request) {
        if (state.polling || !state.statusUrl) return;
        state.polling = true;
        state.pollPromise = (async () => {
            while (state.status === 'queued' || state.status === 'processing') {
                await wait(POLL_INTERVAL);
                let result;
                try { result = await request(state.statusUrl); }
                catch (error) {
                    state.status = 'failed'; state.message = '音轨修正状态读取失败：' + error.message; break;
                }
                applyResult(state, result);
                if (result.status === 'completed') state.force = false;
                state.render?.();
            }
        })().finally(() => { state.polling = false; state.pollPromise = null; state.render?.(); });
    }
    function create(task, root, request) {
        const key = root + ':' + task.id;
        if (!states.has(key)) states.set(key, { force:false, submitting:false, inspecting:false, lastInspectedAt:0, status:'idle', message:'', jobId:'', statusUrl:'', downloadUrl:'', name:'', progress:null, polling:false, pollPromise:null });
        const state = states.get(key), panel = document.createElement('div');
        panel.className = 'audio-repair-panel';
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = '下载音轨修正版';
        const label = document.createElement('label'), checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.checked = state.force;
        checkbox.onchange = () => { state.force = checkbox.checked; state.render?.(); };
        label.append(checkbox, '重新修正音轨');
        const status = document.createElement('span'); status.className = 'audio-repair-status'; status.setAttribute('role', 'status'); status.textContent = state.message;
        const progress = document.createElement('progress'); progress.className = 'audio-repair-progress'; progress.max = 100; progress.hidden = true;
        button.onclick = async () => {
            if (state.submitting || state.status === 'queued' || state.status === 'processing') return;
            if (state.status === 'completed' && !checkbox.checked && state.downloadUrl) {
                startDownload(state); state.message = '正在下载音轨修正版。'; state.render?.(); return;
            }
            const action = checkbox.checked ? '将重新生成修正版。' : '已有有效修正版时直接复用。';
            if (!confirm('服务器将按 ffmpeg -i INPUT.mp4 OUTPUT.mp4 的方式重新编码完整音视频，修正截取片段后的音轨 offset 错位，另存并下载完整修正版，原文件保留。' + action + '\n是否继续？')) return;
            state.submitting = true;
            state.message = '正在提交后端转码队列…'; state.render?.();
            try {
                const result = await request(root + '/tasks/' + encodeURIComponent(task.id) + '/audio-repair', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: checkbox.checked })
                });
                applyResult(state, result);
                if (result.status === 'completed') {
                    state.force = checkbox.checked = false;
                } else {
                    beginPolling(state, request);
                }
            } catch (error) { state.message = status.textContent = '音轨修正失败：' + error.message; }
            finally { state.submitting = false; state.render?.(); }
        };
        state.render = () => { checkbox.checked = state.force; updateView(state, button, checkbox, status, progress); };
        state.render();
        if (state.status === 'queued' || state.status === 'processing') beginPolling(state, request);
        else if (state.status === 'idle' && !state.inspecting && Date.now() - state.lastInspectedAt >= 10000) {
            state.inspecting = true;
            request(root + '/tasks/' + encodeURIComponent(task.id) + '/audio-repair/status').then(result => {
                applyResult(state, result);
                if (result.status === 'queued' || result.status === 'processing') beginPolling(state, request);
            }).catch(() => {}).finally(() => { state.inspecting = false; state.lastInspectedAt = Date.now(); state.render?.(); });
        }
        panel.append(button, label, status, progress);
        return panel;
    }
    window.AudioTrackRepair = { create, busy: () => [...states.values()].some(state => state.submitting) };
})();
