'use strict';
(function () {
    const states = new Map();
    function create(task, root, request) {
        const key = root + ':' + task.id;
        if (!states.has(key)) states.set(key, { force: false, busy: false, message: '' });
        const state = states.get(key), panel = document.createElement('div');
        panel.className = 'audio-repair-panel';
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = '下载音轨修正版'; button.disabled = state.busy;
        const label = document.createElement('label'), checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.checked = state.force; checkbox.disabled = state.busy;
        checkbox.onchange = () => { state.force = checkbox.checked; };
        label.append(checkbox, '重新修正音轨');
        const status = document.createElement('span'); status.className = 'audio-repair-status'; status.setAttribute('role', 'status'); status.textContent = state.message;
        button.onclick = async () => {
            if (state.busy) return;
            const action = checkbox.checked ? '将重新生成修正版。' : '已有有效修正版时直接复用。';
            if (!confirm('服务器将使用 ffmpeg 校正音轨时间戳和漂移，保留视频画面，将音轨转为 AAC，另存修正版后下载，原文件保留。' + action + '\n是否继续？')) return;
            state.busy = true; button.disabled = checkbox.disabled = true;
            state.message = status.textContent = '正在生成或读取音轨修正版，请稍候…';
            try {
                const result = await request(root + '/tasks/' + encodeURIComponent(task.id) + '/audio-repair', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: checkbox.checked })
                });
                const download = document.createElement('a'); download.href = result.downloadUrl; download.download = result.name;
                document.body.append(download); download.click(); download.remove();
                state.message = status.textContent = result.reused ? '已使用缓存修正版，开始下载。' : '音轨修正版已另存，开始下载。';
                state.force = checkbox.checked = false;
            } catch (error) { state.message = status.textContent = '音轨修正失败：' + error.message; }
            finally { state.busy = false; button.disabled = checkbox.disabled = false; }
        };
        panel.append(button, label, status);
        return panel;
    }
    window.AudioTrackRepair = { create, busy: () => [...states.values()].some(state => state.busy) };
})();
