'use strict';
(function () {
    const states = new Map();
    const POLL_INTERVAL = 1200;
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    function startDownload(state, result) {
        if (state.downloadedJobId === result.jobId) return;
        state.downloadedJobId = result.jobId;
        const download = document.createElement('a'); download.href = result.downloadUrl; download.download = result.name;
        document.body.append(download); download.click(); download.remove();
    }
    function updateView(state, button, checkbox, status) {
        const running = state.status === 'queued' || state.status === 'processing';
        button.disabled = state.submitting || running;
        checkbox.disabled = state.submitting || running;
        status.textContent = state.message;
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
                state.status = result.status;
                state.message = result.status === 'queued' ? '已加入后端转码队列，等待处理…'
                    : result.status === 'processing' ? '服务器正在生成音轨修正版…'
                    : result.status === 'completed' ? (result.reused ? '已使用缓存修正版，开始下载。' : '音轨修正版已另存，开始下载。')
                    : '音轨修正失败：' + (result.error || '未知错误');
                if (result.status === 'completed') { startDownload(state, result); state.force = false; }
                state.render?.();
            }
        })().finally(() => { state.polling = false; state.pollPromise = null; state.render?.(); });
    }
    function create(task, root, request) {
        const key = root + ':' + task.id;
        if (!states.has(key)) states.set(key, { force:false, submitting:false, status:'idle', message:'', jobId:'', statusUrl:'', polling:false, pollPromise:null, downloadedJobId:'' });
        const state = states.get(key), panel = document.createElement('div');
        panel.className = 'audio-repair-panel';
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = '下载音轨修正版';
        const label = document.createElement('label'), checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.checked = state.force;
        checkbox.onchange = () => { state.force = checkbox.checked; };
        label.append(checkbox, '重新修正音轨');
        const status = document.createElement('span'); status.className = 'audio-repair-status'; status.setAttribute('role', 'status'); status.textContent = state.message;
        button.onclick = async () => {
            if (state.submitting || state.status === 'queued' || state.status === 'processing') return;
            const action = checkbox.checked ? '将重新生成修正版。' : '已有有效修正版时直接复用。';
            if (!confirm('服务器将按 ffmpeg -i INPUT.mp4 OUTPUT.mp4 的方式重新编码完整音视频，修正截取片段后的音轨 offset 错位，另存并下载完整修正版，原文件保留。' + action + '\n是否继续？')) return;
            state.submitting = true;
            state.message = '正在提交后端转码队列…'; state.render?.();
            try {
                const result = await request(root + '/tasks/' + encodeURIComponent(task.id) + '/audio-repair', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: checkbox.checked })
                });
                state.jobId = result.jobId; state.statusUrl = result.statusUrl; state.status = result.status;
                if (result.status === 'completed') {
                    state.message = result.reused ? '已使用缓存修正版，开始下载。' : '音轨修正版已另存，开始下载。';
                    startDownload(state, result); state.force = checkbox.checked = false;
                } else {
                    state.message = result.status === 'processing' ? '服务器正在生成音轨修正版…' : '已加入后端转码队列，等待处理…';
                    beginPolling(state, request);
                }
            } catch (error) { state.message = status.textContent = '音轨修正失败：' + error.message; }
            finally { state.submitting = false; state.render?.(); }
        };
        state.render = () => { checkbox.checked = state.force; updateView(state, button, checkbox, status); };
        state.render();
        if (state.status === 'queued' || state.status === 'processing') beginPolling(state, request);
        panel.append(button, label, status);
        return panel;
    }
    window.AudioTrackRepair = { create, busy: () => [...states.values()].some(state => state.submitting) };
})();
