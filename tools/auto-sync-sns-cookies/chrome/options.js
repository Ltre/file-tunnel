'use strict';

const webext = globalThis.browser || globalThis.chrome;
const REQUIRED_SYNC_PROTOCOL_VERSION = 2;
const fields = {
    intervalMinutes: document.getElementById('intervalMinutes'),
    pageResyncMinutes: document.getElementById('pageResyncMinutes'),
    enabled: document.getElementById('enabled')
};
const serverList = document.getElementById('serverList');
const serverDialog = document.getElementById('serverDialog');
const serverUrlInput = document.getElementById('serverUrl');
const syncTokenInput = document.getElementById('syncToken');
const syncYoutubePremiumInput = document.getElementById('syncYoutubePremium');
const serverDialogStatus = document.getElementById('serverDialogStatus');
const configBackupInput = document.getElementById('configBackup');
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

function encodeConfigBackup(value) {
    let binary = '';
    for (const byte of new TextEncoder().encode(JSON.stringify(value))) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function parseConfigBackup(value) {
    const encoded = String(value || '').replace(/\s/g, '');
    if (!encoded || encoded.length > 128 * 1024) throw new Error('配置备份为空或过大');
    let backup;
    try {
        backup = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), char => char.charCodeAt(0))));
    } catch (_) {
        throw new Error('配置备份不是有效的 Base64');
    }
    if (backup?.format !== 'drop2tunnel-sns-cookie-sync' || backup.version !== 1 || !Array.isArray(backup.servers)) {
        throw new Error('无法识别这个配置备份');
    }
    if (!backup.servers.length || backup.servers.length > 50) throw new Error('配置备份中的服务器数量无效');
    const importedServers = [...new Map(backup.servers.map(server => {
        const serverUrl = normalizeServerUrl(server?.serverUrl);
        return [serverUrl, {
            id: crypto.randomUUID(),
            serverUrl,
            syncToken: normalizeSyncToken(server?.syncToken),
            syncYoutubePremium: server?.syncYoutubePremium === true
        }];
    })).values()];
    return {
        servers: importedServers,
        enabled: backup.settings?.enabled === true,
        intervalMinutes: Math.max(5, Number(backup.settings?.intervalMinutes) || 15),
        pageResyncMinutes: Math.max(5, Number(backup.settings?.pageResyncMinutes) || 30)
    };
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
        meta.textContent = server.syncYoutubePremium ? '公共 SNS + 私人 YouTube Premium' : '公共 SNS Cookie';
        main.append(name, meta);

        const actions = document.createElement('div');
        actions.className = 'server-actions';
        actions.append(
            createIconButton('↗', '打开此服务器的 SNS Cookie 管理页', () => {
                webext.tabs.create({ url: `${server.serverUrl}/sns-cookies` });
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
    const response = await webext.runtime.sendMessage({ type: 'get-settings' });
    if (!response?.ok) throw new Error(response?.error || '读取设置失败');
    if (response.protocolVersion !== REQUIRED_SYNC_PROTOCOL_VERSION) {
        throw new Error('扩展后台仍在运行旧版本，请到扩展管理页点击“重新加载”后再试');
    }
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
    syncYoutubePremiumInput.checked = server?.syncYoutubePremium === true;
    serverDialogStatus.textContent = '';
    serverDialog.showModal();
    serverUrlInput.focus();
}

async function removeUnusedPermission(serverUrl) {
    if (servers.some(server => server.serverUrl === serverUrl)) return;
    await webext.permissions.remove({ origins: [`${serverUrl}/*`] }).catch(() => false);
}

async function saveServer() {
    const serverUrl = normalizeServerUrl(serverUrlInput.value);
    const syncToken = normalizeSyncToken(syncTokenInput.value);
    if (servers.some(server => server.id !== editingServerId && server.serverUrl === serverUrl)) {
        throw new Error('该服务器已经存在');
    }

    const previous = servers.find(server => server.id === editingServerId);
    const next = {
        id: editingServerId || crypto.randomUUID(),
        serverUrl,
        syncToken,
        syncYoutubePremium: syncYoutubePremiumInput.checked
    };
    servers = previous ? servers.map(server => server.id === editingServerId ? next : server) : [...servers, next];
    await webext.storage.local.set({ servers, lastCookieHash: '', lastSyncAt: 0, lastResult: '', lastError: '' });
    if (previous && previous.serverUrl !== serverUrl) await removeUnusedPermission(previous.serverUrl);
    serverDialog.close();
    renderServers();
    setStatus('服务器配置已保存，正在请求访问权限...');
    const granted = await webext.permissions.request({ origins: [`${serverUrl}/*`] });
    if (!granted) throw new Error(`服务器配置已保存，但尚未授予访问 ${serverUrl} 的权限`);
    setStatus(`${previous ? '服务器配置已更新' : '服务器已添加'}${next.syncYoutubePremium ? '，私人 Premium 同步已启用' : ''}。`, 'ok');
}

async function deleteServer(server) {
    if (!confirm(`确定删除服务器 ${server.serverUrl} 吗？`)) return;
    servers = servers.filter(item => item.id !== server.id);
    await webext.storage.local.set({
        servers,
        lastCookieHash: '',
        lastSyncAt: 0,
        lastResult: '',
        lastError: '',
        ...(servers.length ? {} : { enabled: false })
    });
    if (!servers.length) {
        fields.enabled.checked = false;
        await webext.runtime.sendMessage({ type: 'configure-alarm' });
    }
    await removeUnusedPermission(server.serverUrl);
    renderServers();
    setStatus('服务器配置已删除。', 'ok');
}

async function saveSettings() {
    if (fields.enabled.checked && !servers.length) throw new Error('启用自动同步前请先添加服务器');
    await webext.storage.local.set({
        intervalMinutes: Math.max(5, Number(fields.intervalMinutes.value) || 15),
        pageResyncMinutes: Math.max(5, Number(fields.pageResyncMinutes.value) || 30),
        enabled: fields.enabled.checked,
        lastError: ''
    });
    await webext.runtime.sendMessage({ type: 'configure-alarm' });
    setStatus('设置已保存。', 'ok');
}

function exportConfig() {
    if (!servers.length) throw new Error('没有可导出的服务器配置');
    configBackupInput.value = encodeConfigBackup({
        format: 'drop2tunnel-sns-cookie-sync',
        version: 1,
        servers: servers.map(({ serverUrl, syncToken, syncYoutubePremium }) => ({
            serverUrl,
            syncToken: normalizeSyncToken(syncToken),
            syncYoutubePremium: syncYoutubePremium === true
        })),
        settings: {
            enabled: fields.enabled.checked,
            intervalMinutes: Math.max(5, Number(fields.intervalMinutes.value) || 15),
            pageResyncMinutes: Math.max(5, Number(fields.pageResyncMinutes.value) || 30)
        }
    });
    configBackupInput.focus();
    configBackupInput.select();
    setStatus(`已导出 ${servers.length} 台服务器配置，请妥善保管。`, 'ok');
}

async function copyConfig() {
    const content = configBackupInput.value.trim();
    if (!content) throw new Error('请先导出配置');
    try {
        await navigator.clipboard.writeText(content);
    } catch (_) {
        configBackupInput.select();
        if (!document.execCommand('copy')) throw new Error('复制失败，请手动复制已选内容');
    }
    setStatus('配置备份已复制。', 'ok');
}

async function importConfig() {
    const imported = parseConfigBackup(configBackupInput.value);
    if (!confirm(`将用备份中的 ${imported.servers.length} 台服务器替换当前配置，确定继续吗？`)) return;
    const previousServers = servers;
    servers = imported.servers;
    fields.enabled.checked = imported.enabled;
    fields.intervalMinutes.value = imported.intervalMinutes;
    fields.pageResyncMinutes.value = imported.pageResyncMinutes;
    await webext.storage.local.set({
        ...imported,
        lastCookieHash: '',
        lastSyncAt: 0,
        lastResult: '',
        lastError: ''
    });
    previousServers.forEach(server => { removeUnusedPermission(server.serverUrl); });
    renderServers();
    setStatus('配置已导入，正在请求服务器访问权限...');
    const origins = servers.map(server => `${server.serverUrl}/*`);
    const granted = await webext.permissions.request({ origins });
    if (!granted) throw new Error('配置已导入，但尚未授予全部服务器的访问权限');
    configBackupInput.value = '';
    setStatus(`已导入 ${servers.length} 台服务器配置。`, 'ok');
}

document.getElementById('addServerBtn').addEventListener('click', () => openServerDialog());
document.getElementById('cancelServerBtn').addEventListener('click', () => serverDialog.close());
document.getElementById('saveServerBtn').addEventListener('click', () => {
    serverDialogStatus.textContent = '';
    saveServer().catch(error => {
        if (serverDialog.open) serverDialogStatus.textContent = error.message;
        else setStatus(error.message, 'error');
    });
});
document.getElementById('saveBtn').addEventListener('click', () => {
    saveSettings().catch(error => setStatus(error.message, 'error'));
});
document.getElementById('exportConfigBtn').addEventListener('click', () => {
    try { exportConfig(); } catch (error) { setStatus(error.message, 'error'); }
});
document.getElementById('copyConfigBtn').addEventListener('click', () => {
    copyConfig().catch(error => setStatus(error.message, 'error'));
});
document.getElementById('importConfigBtn').addEventListener('click', () => {
    importConfig().catch(error => setStatus(error.message, 'error'));
});
document.getElementById('syncBtn').addEventListener('click', async event => {
    try {
        event.currentTarget.disabled = true;
        await saveSettings();
        setStatus(`正在读取各 SNS 平台 Cookie 并同步到 ${servers.length} 台服务器...`);
        const response = await webext.runtime.sendMessage({ type: 'sync-now' });
        if (!response?.ok) throw new Error(response?.error || '同步失败');
        if (response.protocolVersion !== REQUIRED_SYNC_PROTOCOL_VERSION) {
            throw new Error('扩展后台仍在运行旧版本，请到扩展管理页点击“重新加载”后再试');
        }
        await loadSettings();
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        event.currentTarget.disabled = false;
    }
});

loadSettings().catch(error => setStatus(error.message, 'error'));
