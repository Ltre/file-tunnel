(function (global) {
    'use strict';
    const STORAGE_KEY = 'tunnelDeviceNotifications:v1';
    let options = {}, overlay, list, count, historyOpen = false;

    function storageKey() { return `${STORAGE_KEY}:${String(options.deviceId?.() || 'local')}`; }
    function read() {
        try { return JSON.parse(localStorage.getItem(storageKey()) || '[]').filter(item => item?.id); }
        catch (_) { return []; }
    }
    function write(items) {
        localStorage.setItem(storageKey(), JSON.stringify(items.slice(0, 300)));
        updateBadges(items);
    }
    function escapeHtml(value) {
        const div = document.createElement('div'); div.textContent = String(value || ''); return div.innerHTML;
    }
    function updateBadges(items = read()) {
        const unread = items.filter(item => !item.read).length;
        document.querySelectorAll('[data-notification-count]').forEach(node => {
            node.textContent = unread ? String(unread) : '';
            node.hidden = !unread;
        });
    }
    function ensureUi() {
        if (overlay) return;
        overlay = document.createElement('section');
        overlay.id = 'notificationCenter'; overlay.className = 'notification-center'; overlay.hidden = true;
        overlay.innerHTML = `<header><button type="button" data-notification-close aria-label="关闭">←</button><div><strong>通知中心</strong><span data-notification-count hidden></span></div><button type="button" data-notification-clear>清空已读</button></header><main><div class="notification-center-list"></div></main>`;
        document.body.append(overlay); list = overlay.querySelector('.notification-center-list'); count = overlay.querySelector('[data-notification-count]');
        overlay.querySelector('[data-notification-close]').onclick = () => close();
        overlay.querySelector('[data-notification-clear]').onclick = () => {
            write(read().filter(item => !item.read)); render();
        };
        overlay.addEventListener('click', async event => {
            const action = event.target.closest('[data-notification-action]');
            if (!action) return;
            const item = read().find(entry => entry.id === action.closest('[data-notification-id]')?.dataset.notificationId);
            if (!item) return;
            action.disabled = true;
            try {
                await options.onAction?.(item, action.dataset.notificationAction);
                const items = read(); const current = items.find(entry => entry.id === item.id);
                if (current) { current.read = true; current.resolved = action.dataset.notificationAction; write(items); }
                render();
            } finally { action.disabled = false; }
        });
    }
    function render() {
        ensureUi();
        const items = read().sort((a, b) => b.createdAt - a.createdAt);
        updateBadges(items);
        if (!items.length) { list.innerHTML = '<div class="notification-center-empty">暂无设备通知</div>'; return; }
        list.innerHTML = items.map(item => `<article class="notification-card${item.read ? '' : ' unread'}" data-notification-id="${escapeHtml(item.id)}">
            <div class="notification-card-head"><strong>${escapeHtml(item.title || '设备通知')}</strong><time>${new Date(item.createdAt).toLocaleString()}</time></div>
            <p>${escapeHtml(item.body || '')}</p>
            ${item.type === 'web-zip-edit-request' && !item.resolved ? `<div class="notification-card-actions"><button type="button" data-notification-action="approve">允许编辑</button><button type="button" data-notification-action="reject">拒绝</button></div>` : ''}
            ${item.resolved ? `<small>已处理：${item.resolved === 'approve' ? '已允许' : '已拒绝'}</small>` : ''}
        </article>`).join('');
    }
    function open() {
        ensureUi(); render(); overlay.hidden = false; overlay.classList.add('active');
        const items = read(); items.forEach(item => { item.read = true; }); write(items);
        render();
        if (!historyOpen) { history.pushState({ ...(history.state || {}), notificationCenter: true }, '', location.href); historyOpen = true; }
    }
    function close(fromHistory = false) {
        if (!overlay || overlay.hidden) return;
        overlay.classList.remove('active'); overlay.hidden = true;
        const shouldBack = historyOpen && !fromHistory && history.state?.notificationCenter;
        historyOpen = false;
        if (shouldBack) history.back();
    }
    function add(notification) {
        const items = read();
        const id = String(notification?.id || `notification-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const next = { ...notification, id, createdAt: Number(notification?.createdAt) || Date.now(), read: false };
        const index = items.findIndex(item => item.id === id);
        if (index >= 0) items[index] = { ...items[index], ...next }; else items.unshift(next);
        write(items); if (overlay && !overlay.hidden) render(); return next;
    }
    function init(config = {}) {
        options = config; ensureUi(); updateBadges();
        window.addEventListener('popstate', () => { if (overlay && !overlay.hidden) close(true); });
        document.addEventListener('keydown', event => { if (event.key === 'Escape' && overlay && !overlay.hidden) { event.preventDefault(); close(); } });
        if (location.pathname === '/notification') setTimeout(open, 0);
    }
    global.NotificationCenter = { init, open, close, add, list: read };
})(window);
