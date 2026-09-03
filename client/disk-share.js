'use strict';
(function () {
    const token = location.pathname.split('/').pop();
    const base = '/api/telegram/disk-shares/' + encodeURIComponent(token);
    const $ = id => document.getElementById(id);
    let abort, url = '', generation = 0;
    const errorText = error => /NOT_FOUND/.test(error.message) ? '分享不存在、已停止，或所选文件已删除。' : '操作失败：' + error.message;
    async function request(path, signal) {
        const response = await fetch(base + path, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '网络请求失败');
        return response;
    }
    function closePreview() {
        $('sharePreview').hidden = true; $('sharePreviewBody').replaceChildren();
        if (url) URL.revokeObjectURL(url); url = '';
    }
    async function work(message, action) {
        abort?.abort(); const controller = new AbortController(); abort = controller; const current = ++generation;
        $('shareLoadingText').textContent = message; $('shareLoading').hidden = false;
        try { await action(controller.signal); }
        catch (error) { if (current === generation && error.name !== 'AbortError') $('shareStatus').textContent = errorText(error); }
        finally { if (current === generation) $('shareLoading').hidden = true; }
    }
    async function openFile(file, preview) {
        return work('正在读取：' + file.name, async signal => {
            const response = await request('/files/' + encodeURIComponent(file.id) + '/download', signal);
            const blob = await response.blob(); if (signal.aborted) return;
            if (!preview) {
                const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); return;
            }
            closePreview(); $('sharePreviewName').textContent = file.name;
            let element;
            if ((file.type || '').startsWith('text/')) { element = document.createElement('pre'); element.textContent = await blob.slice(0, 2 * 1024 * 1024).text(); }
            else {
                url = URL.createObjectURL(new Blob([blob], { type: file.type }));
                element = document.createElement(file.type.startsWith('image/') ? 'img' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : 'iframe');
                if (element.tagName === 'IFRAME') element.setAttribute('sandbox', '');
                if (element.tagName === 'IMG') element.alt = file.name;
                element.title = file.name; element.controls = true; element.src = url;
            }
            if (signal.aborted) { closePreview(); return; }
            $('sharePreviewBody').replaceChildren(element); $('sharePreview').hidden = false;
        });
    }
    async function list(path = '') {
        closePreview(); $('shareStatus').textContent = ''; $('shareItems').replaceChildren();
        return work('正在加载分享内容…', async signal => {
            const data = await (await request('?path=' + encodeURIComponent(path), signal)).json();
            if (signal.aborted) return;
            $('shareTitle').textContent = data.title; $('shareBreadcrumbs').replaceChildren();
            const parts = path.split('/').filter(Boolean);
            for (let index = 0; index <= parts.length; index++) {
                const button = document.createElement('button'); button.textContent = index ? parts[index - 1] : '根目录'; button.onclick = () => list(parts.slice(0, index).join('/')); $('shareBreadcrumbs').append(button);
            }
            for (const item of [...data.folders, ...data.files]) {
                const row = document.createElement('div'); row.className = 'disk-public-item';
                const open = document.createElement('button'); open.className = 'disk-public-name'; open.textContent = (item.kind === 'directory' ? '📁 ' : '📄 ') + item.name;
                const previewable = /^(image|audio|video|text)\//.test(item.type || '') || item.type === 'application/pdf';
                open.onclick = () => item.kind === 'directory' ? list(item.path) : openFile(item, previewable);
                row.append(open);
                if (item.kind !== 'directory') {
                    const size = document.createElement('small'); size.textContent = Number(item.size).toLocaleString('zh-CN') + ' 字节';
                    const download = document.createElement('button'); download.textContent = '下载'; download.onclick = () => openFile(item, false); row.append(size, download);
                }
                $('shareItems').append(row);
            }
            if (!data.files.length && !data.folders.length) $('shareStatus').textContent = '此目录没有文件。';
        });
    }
    $('sharePreviewClose').onclick = closePreview;
    $('shareCancel').onclick = () => { abort?.abort(); $('shareLoading').hidden = true; };
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { abort?.abort(); closePreview(); } });
    window.addEventListener('pagehide', () => { abort?.abort(); closePreview(); });
    list();
})();
