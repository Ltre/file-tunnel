'use strict';
(function () {
    const items = [
        ['概览', '/admin/home', '⌂', '隧道总览'],
        ['', '/admin/devices', '◎', '所有访问设备'],
        ['', '/admin/magnets', '🧲', '已分享磁链'],
        ['媒体工具', '/sns-dl', '↓', 'SNS 媒体下载'],
        ['', '/youtube-premium-dl', '▶', 'YouTube Premium 下载'],
        ['', '/media-library', '▧', '画面提取与多媒体收藏'],
        ['', '/video-transcode', '◈', '视频转码'],
        ['网盘与存储', '/disk-management', '▤', '网盘用户与内容审核'],
        ['', '/s3-management', 'S₃', 'S3 API 第三方接入'],
        ['', '/telegram-content', '✈', 'Telegram Bot 内容管理'],
        ['', '/data-usage', '◴', '数据目录空间占用'],
        ['配置', '/tgbot', '⚙', 'Telegram Bot 配置'],
        ['', '/sns-cookies', '◉', 'SNS Cookies 配置']
    ];
    const allowed = new Set([...items.map(item => item[1]), '/vclient', '/video-transcode-guide.html']);
    const frame = document.getElementById('admin-content'), nav = document.getElementById('admin-navigation');
    const toggle = document.getElementById('admin-menu-toggle'), sidebar = document.querySelector('.admin-sidebar');
    const title = document.getElementById('admin-page-title'), status = document.getElementById('admin-load-state'), standalone = document.getElementById('admin-open-page');
    function internal(value) {
        const url = new URL(value, location.origin);
        if (url.origin !== location.origin) return null;
        if (url.pathname === '/admin') url.pathname = '/admin/home';
        if (!allowed.has(url.pathname)) return null;
        url.searchParams.delete('admin_frame');
        return url;
    }
    function label(url) { return items.find(item => item[1] === url.pathname)?.[3] || (url.pathname === '/vclient' ? '浏览器缓存详情' : '视频转码帮助'); }
    function mark(url) {
        title.textContent = label(url); document.title = label(url) + ' · Drop2Tunnel 管理后台';
        for (const link of nav.querySelectorAll('a')) { if (link.dataset.path === url.pathname) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }
        const direct = new URL(url); direct.searchParams.set('admin_frame', '1'); standalone.href = direct.pathname + direct.search + direct.hash;
    }
    function show(url, push = true) {
        mark(url); status.textContent = '正在加载…';
        const child = new URL(url); child.searchParams.set('admin_frame', '1'); frame.src = child.pathname + child.search + child.hash;
        if (push) history.pushState(null, '', '/admin?view=' + encodeURIComponent(url.pathname + url.search + url.hash));
        sidebar.classList.remove('is-expanded'); toggle.setAttribute('aria-expanded', 'false');
    }
    for (const [group, path, icon, text] of items) {
        if (group) { const heading = document.createElement('div'); heading.className = 'admin-nav-heading'; heading.textContent = group; nav.append(heading); }
        const link = document.createElement('a'); link.href = path; link.dataset.path = path; link.className = 'admin-nav-link';
        const mark = document.createElement('span'); mark.className = 'admin-nav-icon'; mark.textContent = icon;
        link.append(mark, document.createTextNode(text)); link.onclick = event => { if (event.ctrlKey || event.metaKey || event.shiftKey) return; event.preventDefault(); show(internal(path)); }; nav.append(link);
    }
    toggle.onclick = () => { const expanded = sidebar.classList.toggle('is-expanded'); toggle.setAttribute('aria-expanded', String(expanded)); };
    function entry() { return internal(new URL(location.href).searchParams.get('view') || location.href) || internal('/admin/home'); }
    frame.addEventListener('load', () => {
        try {
            const current = new URL(frame.contentWindow.location.href);
            if (current.origin !== location.origin) { status.textContent = '当前页面无法读取'; return; }
            if (current.pathname.startsWith('/admin-auth')) { location.assign(current.href); return; }
            const url = internal(current.href); if (url) { mark(url); history.replaceState(null, '', '/admin?view=' + encodeURIComponent(url.pathname + url.search + url.hash)); }
            status.textContent = '已加载';
            frame.contentDocument.addEventListener('click', event => {
                if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                const anchor = event.target.closest('a[href]'); if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
                const url = internal(anchor.href); if (url) { event.preventDefault(); show(url); }
                else if (['/', '/disk'].includes(new URL(anchor.href).pathname) && new URL(anchor.href).origin === location.origin) { event.preventDefault(); window.open(anchor.href, '_blank', 'noopener'); }
            });
        } catch (_) { status.textContent = '页面已加载'; }
    });
    frame.addEventListener('error', () => { status.textContent = '加载失败，请重新选择功能'; });
    addEventListener('popstate', () => show(entry(), false));
    show(entry(), false);
})();
