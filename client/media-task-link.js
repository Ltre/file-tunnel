// Optional bridge used only for a media-library initiated download. Existing
// downloads remain independent; binding failure never creates a second task.
(function () {
    'use strict';
    const parameters = new URLSearchParams(location.search), id = parameters.get('media_import'), token = parameters.get('media_bind');
    const kind = location.pathname.includes('youtube-premium') ? 'youtube' : 'sns', key = 'media-task-link:' + id;
    if (!id || !token) return;
    function announce(message) {
        let notice = document.getElementById('mediaTaskLinkNotice');
        if (!notice) { notice = document.createElement('p'); notice.id = 'mediaTaskLinkNotice'; notice.setAttribute('role', 'status'); document.getElementById('urlInput')?.parentElement?.append(notice); }
        notice.textContent = message;
    }
    async function bind(taskId) {
        const response = await fetch('/api/media-library/imports/' + encodeURIComponent(id) + '/attach', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, taskId, token }) });
        const result = await response.json(); if (!response.ok) throw Error(result.message || result.error);
        try { sessionStorage.removeItem(key); } catch (_) {}
        announce('已关联媒体收藏工作区。下载完成后由服务端转存，可以关闭页面。');
    }
    window.MediaTaskLink = { async created(task) {
        try { sessionStorage.setItem(key, task.id); } catch (_) {}
        try { await bind(task.id); } catch (error) { announce('下载任务已创建，工作区关联暂未完成：' + error.message + '。刷新后会重试关联，不会重复创建任务。'); }
    } };
    const input = document.getElementById('urlInput'); if (input && !input.value) input.value = parameters.get('url') || '';
    let pending; try { pending = sessionStorage.getItem(key); } catch (_) {}
    if (pending) bind(pending).catch(error => announce('关联仍待恢复：' + error.message));
    else announce('创建本次任务后，会关联到媒体收藏工作区；抓取仍由本页面执行。');
})();
