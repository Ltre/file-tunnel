'use strict';

const fields = {
    intervalMinutes: document.getElementById('intervalMinutes'),
    pageResyncMinutes: document.getElementById('pageResyncMinutes'),
    enabled: document.getElementById('enabled')
};
const serverList = document.getElementById('serverList');
const serverDialog = document.getElementById('serverDialog');
const serverUrlInput = document.getElementById('serverUrl');
const syncTokenInput = document.getElementById('syncToken');
const serverDialogStatus = document.getElementById('serverDialogStatus');
const statusEl = document.getElementById('status');
let servers = [];
let editingServerId = '';

function setStatus(message, type = '') {
    statusEl.textContent = message;
    statusEl.className = type;
}

function normalizeServerUrl(value) {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('服务器地址必须使用 HTTP 或 HTTPS');
    return url.origin;
}

function normalizeSyncToken(value) {
    const matches = String(value || '').split(/[^A-Za-z0-9_-]+/).filter(part => part.length === 43);
    if (matches.length !== 1) throw new Error('同步密钥格式无效，请重新复制管理页生成的密钥');
    return matches[0];
}

function createIconButton(symbol, title, handler, danger = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `icon${danger ? ' danger' : ''}`;
    button.textContent = symbol;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', handler);
    return button;
}

function renderServers() {
    serverList.replaceChildren();
    if (!servers.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '尚未添加服务器';
        serverList.appendChild(empty);
        return;
    }
    servers.forEach(server => {
        const row = document.createElement('div');
        row.className = 'server-row';
        const main = document.createElement('div');
        main.className = 'server-main';
        const name = document.createElement('strong');
        name.textContent = server.serverUrl;
        const meta = document.createElement('span');
        meta.className = 'server-meta';
        meta.textContent = '同步密钥已配置';
        main.append(name, meta);

        const actions = document.createElement('div');
        actions.className = 'server-actions';
        actions.append(
            createIconButton('↗', '打开此服务器的 SNS Cookie 管理页', () => {
                chrome.tabs.create({ url: `${server.serverUrl}/sns-cookies` });
            }),
            createIconButton('✎', '修改服务器', () => openServerDialog(server)),
            createIconButton('×', '删除服务器', () => {
                deleteServer(server).catch(error => setStatus(error.message, 'error'));
            }, true)
        );
        row.append(main, actions);
        serverList.appendChild(row);
    });
}

async function loadSettings() {
    const response = await chrome.runtime.sendMessage({ type: 'get-settings' });
    if (!response?.ok) throw new Error(response?.error || '读取设置失败');
    const settings = response.settings;
    servers = Array.isArray(settings.servers) ? settings.servers : [];
    fields.intervalMinutes.value = settings.intervalMinutes;
    fields.pageResyncMinutes.value = settings.pageResyncMinutes;
    fields.enabled.checked = Boolean(settings.enabled);
    renderServers();
    setStatus(settings.lastError || settings.lastResult || '尚未执行同步。', settings.lastError ? 'error' : (settings.lastResult ? 'ok' : ''));
}

function openServerDialog(server = null) {
    editingServerId = server?.id || '';
    document.getElementById('serverDialogTitle').textContent = server ? '修改服务器' : '添加服务器';
    serverUrlInput.value = server?.serverUrl || '';
    syncTokenInput.value = server?.syncToken || '';
    serverDialogStatus.textContent = '';
    serverDialog.showModal();
    serverUrlInput.focus();
}

async function removeUnusedPermission(serverUrl) {
    if (servers.some(server => server.serverUrl === serverUrl)) return;
    await chrome.permissions.remove({ origins: [`${serverUrl}/*`] }).catch(() => false);
}

async function saveServer() {
    const serverUrl = normalizeServerUrl(serverUrlInput.value);
    const syncToken = normalizeSyncToken(syncTokenInput.value);
    if (servers.some(server => server.id !== editingServerId && server.serverUrl === serverUrl)) {
        throw new Error('该服务器已经存在');
    }
    const granted = await chrome.permissions.request({ origins: [`${serverUrl}/*`] });
    if (!granted) throw new Error(`未授予访问 ${serverUrl} 的权限`);

    const previous = servers.find(server => server.id === editingServerId);
    const next = { id: editingServerId || crypto.randomUUID(), serverUrl, syncToken };
    servers = previous ? servers.map(server => server.id === editingServerId ? next : server) : [...servers, next];
    await chrome.storage.local.set({ servers, lastCookieHash: '', lastSyncAt: 0, lastResult: '', lastError: '' });
    if (previous && previous.serverUrl !== serverUrl) await removeUnusedPermission(previous.serverUrl);
    serverDialog.close();
    renderServers();
    setStatus(previous ? '服务器配置已更新。' : '服务器已添加。', 'ok');
}

async function deleteServer(server) {
    if (!confirm(`确定删除服务器 ${server.serverUrl} 吗？`)) return;
    servers = servers.filter(item => item.id !== server.id);
    await chrome.storage.local.set({
        servers,
        lastCookieHash: '',
        lastSyncAt: 0,
        lastResult: '',
        lastError: '',
        ...(servers.length ? {} : { enabled: false })
    });
    if (!servers.length) {
        fields.enabled.checked = false;
        await chrome.runtime.sendMessage({ type: 'configure-alarm' });
    }
    await removeUnusedPermission(server.serverUrl);
    renderServers();
    setStatus('服务器配置已删除。', 'ok');
}

async function saveSettings() {
    if (fields.enabled.checked && !servers.length) throw new Error('启用自动同步前请先添加服务器');
    await chrome.storage.local.set({
        intervalMinutes: Math.max(5, Number(fields.intervalMinutes.value) || 15),
        pageResyncMinutes: Math.max(5, Number(fields.pageResyncMinutes.value) || 30),
        enabled: fields.enabled.checked,
        lastError: ''
    });
    await chrome.runtime.sendMessage({ type: 'configure-alarm' });
    setStatus('设置已保存。', 'ok');
}

document.getElementById('addServerBtn').addEventListener('click', () => openServerDialog());
document.getElementById('cancelServerBtn').addEventListener('click', () => serverDialog.close());
document.getElementById('saveServerBtn').addEventListener('click', () => {
    serverDialogStatus.textContent = '';
    saveServer().catch(error => { serverDialogStatus.textContent = error.message; });
});
document.getElementById('saveBtn').addEventListener('click', () => {
    saveSettings().catch(error => setStatus(error.message, 'error'));
});
document.getElementById('syncBtn').addEventListener('click', async event => {
    try {
        event.currentTarget.disabled = true;
        await saveSettings();
        setStatus(`正在读取各 SNS 平台 Cookie 并同步到 ${servers.length} 台服务器...`);
        const response = await chrome.runtime.sendMessage({ type: 'sync-now' });
        if (!response?.ok) throw new Error(response?.error || '同步失败');
        await loadSettings();
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        event.currentTarget.disabled = false;
    }
});

loadSettings().catch(error => setStatus(error.message, 'error'));
