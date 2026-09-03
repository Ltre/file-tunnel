'use strict';
// Standalone drive UI: no tunnel/session/collection dependencies.
(function () {
let formatFileSize = value => value + ' B', showAppToast = message => alert(message), historyLog = () => {};
let telegramDrivePath = '';
let telegramDriveOidcPopup = null;
let telegramDriveOidcPollGeneration = 0;
let telegramDriveCurrentData = null;
let telegramDriveMenuItem = null;
const telegramDriveSelected = new Map();
let telegramDriveView = localStorage.getItem('telegram-drive-view') === 'grid' ? 'grid' : 'list';
let telegramDriveSort = localStorage.getItem('telegram-drive-sort') || 'name';
let telegramDriveSortAscending = localStorage.getItem('telegram-drive-sort-ascending') !== 'false';
async function telegramDriveRequest(url, options = {}) { return window.DiskClient.request(url, options); }
// Background identity/OIDC polling must not repeatedly open the loading dialog.
async function getTelegramDriveIdentity() { return window.DiskClient.raw('/me'); }
function telegramDriveErrorText(error) {
    const code = String(error?.message || error || '');
    const messages = {
        'DISK_NAME_INVALID': '名称不合法：不能包含路径分隔符、.. 或系统保留字符',
        'DISK_NAME_CONFLICT': '目标位置已存在或正在上传同名文件/目录，不会覆盖',
        'DISK_BUSY': '当前网盘正在完成另一项操作，请稍后再试',
        'DISK_UPLOAD_IN_PROGRESS': '此目录仍有文件正在上传，请等待上传结束',
        'DISK_DELETE_PARTIAL': '部分 Telegram 文件删除失败，未删除的记录已保留',
        'DISK_BATCH_LIMIT': '每批请选择 1–100 个文件',
        'USERNAME_INVALID': '账号名须为 3–64 位字母、数字、下划线、点或短横线',
        'USERNAME_EXISTS': '账号名已被使用，请更换名称或选择登录',
        'PASSKEY_ACCOUNT_NOT_FOUND': '该账号尚未在此域名注册 Passkey',
        'PASSKEY_FLOW_INVALID': '验证已失效，请重新开始',
        'PASSKEY_VERIFICATION_FAILED': 'Passkey 验证失败，请重试',
        'PASSKEY_SERVER_UNAVAILABLE': '服务端 Passkey 依赖缺失，请管理员在部署目录执行 npm ci 并重启服务',
        'LOCAL_USE_OIDC_MOCK': 'localhost 和局域网测试请使用 Telegram OIDC Mock',
        'LOGIN_REQUIRED': '请先登录网盘',
        'STORAGE_BACKEND_UNAVAILABLE': '管理员尚未配置可用的网盘存储频道',
        'TELEGRAM_NETWORK_ERROR': '连接 Telegram 失败，请检查服务器网络',
        'SERVER_RESTARTED': '服务已重启，此任务未完成，请重新执行',
        'telegram-drive-folder-depth-exceeded': '目录层级超过管理员设置的上限',
        'telegram-drive-folder-name-required': '请输入有效的文件夹名称',
        'telegram-drive-folder-not-found': '文件夹不存在或已被移动',
        'telegram-drive-destination-not-found': '目标文件夹不存在',
        'telegram-drive-folder-cycle': '不能把文件夹移动到自身或其子目录中',
        'telegram-drive-folder-exists': '目标位置已存在同名文件夹',
        'telegram-drive-folder-not-empty': '文件夹不为空',
        'telegram-drive-file-name-required': '请输入有效的文件名',
        'telegram-drive-file-not-found': '文件不存在或已被删除',
        'telegram-drive-delete-partial': '部分 Telegram 文件删除失败，未删除的记录已保留',
        'telegram-drive-channel-not-configured': '管理员尚未配置网盘存储频道',
        'telegram-drive-upload-size-invalid': '文件总大小为空或超过当前上传限制'
    };
    return messages[code] || code || 'Telegram 网盘操作失败';
}

function telegramDriveItemKey(item) { return item.kind === 'directory' ? `directory:${item.path}` : `file:${item.id}`; }
function telegramDriveDisplayPath(value = '') { return value ? `/${value}` : '/'; }
function telegramDriveFormatDate(value) { return Number(value) ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function clearTelegramDriveSearch() {
    const input = document.getElementById('telegramDriveSearch');
    if (input) input.value = '';
}
function telegramDriveFileType(item) {
    if (item.kind === 'directory') return '文件夹';
    const type = String(item.type || 'application/octet-stream');
    return type === 'application/octet-stream' ? '文件' : type;
}

function closeTelegramDriveItemMenu() {
    const menu = document.getElementById('telegramDriveItemMenu');
    if (menu) { menu.hidden = true; menu.replaceChildren(); }
    telegramDriveMenuItem = null;
}

function closeTelegramDriveDialog(result = null) {
    const dialog = document.getElementById('telegramDriveDialog');
    if (!dialog) return;
    const resolver = dialog._telegramDriveResolver;
    dialog._telegramDriveResolver = null;
    dialog.hidden = true;
    dialog.onkeydown = null;
    document.getElementById('telegramDriveDialogBody')?.replaceChildren();
    document.getElementById('telegramDriveDialogActions')?.replaceChildren();
    if (resolver) resolver(result);
}

function openTelegramDriveDialog({ title, body, confirmText = '确定', confirmClass = 'btn-primary', cancelText = '取消', validate } = {}) {
    const dialog = document.getElementById('telegramDriveDialog');
    const titleEl = document.getElementById('telegramDriveDialogTitle');
    const bodyEl = document.getElementById('telegramDriveDialogBody');
    const actions = document.getElementById('telegramDriveDialogActions');
    closeTelegramDriveItemMenu();
    titleEl.textContent = title || 'Telegram网盘';
    bodyEl.replaceChildren(...(Array.isArray(body) ? body : [body]).filter(Boolean));
    actions.replaceChildren();
    const cancel = cancelText ? document.createElement('button') : null;
    if (cancel) { cancel.className = 'btn btn-secondary'; cancel.type = 'button'; cancel.textContent = cancelText; }
    const confirm = document.createElement('button'); confirm.className = `btn ${confirmClass}`; confirm.type = 'button'; confirm.textContent = confirmText;
    if (cancel) actions.append(cancel);
    actions.append(confirm);
    dialog.hidden = false;
    return new Promise(resolve => {
        dialog._telegramDriveResolver = resolve;
        if (cancel) cancel.onclick = () => closeTelegramDriveDialog(null);
        confirm.onclick = async () => {
            if (confirm.disabled) return;
            confirm.disabled = true;
            try {
                const result = validate ? await validate() : true;
                if (result === false) return;
                closeTelegramDriveDialog(result);
            } catch (error) { alert(telegramDriveErrorText(error)); }
            finally { confirm.disabled = false; }
        };
        dialog.onkeydown = event => {
            if (event.isComposing) return;
            if (event.key === 'Escape') { event.stopPropagation(); closeTelegramDriveDialog(null); }
            if (event.key === 'Enter' && event.target.matches('input')) { event.preventDefault(); confirm.click(); }
        };
        setTimeout(() => bodyEl.querySelector('input,select,button')?.focus(), 0);
    });
}

async function promptTelegramDriveText(title, value = '', { placeholder = '', confirmText = '确定' } = {}) {
    const label = document.createElement('label'); label.textContent = title;
    const input = document.createElement('input'); input.type = 'text'; input.value = value; input.placeholder = placeholder; input.maxLength = 200;
    return openTelegramDriveDialog({ title, body: [label, input], confirmText, validate: () => {
        const next = input.value.trim();
        if (!next) { input.focus(); throw new Error('请输入内容'); }
        return next;
    } });
}

async function confirmTelegramDriveAction(title, message, confirmText = '确定') {
    const paragraph = document.createElement('p'); paragraph.textContent = message; paragraph.style.margin = '0';
    return Boolean(await openTelegramDriveDialog({ title, body: paragraph, confirmText, confirmClass: 'btn-primary' }));
}

function clearTelegramDriveSelection() {
    telegramDriveSelected.clear();
    updateTelegramDriveSelectionBar();
    document.querySelectorAll('#telegramDriveList .telegram-drive-item').forEach(row => row.classList.remove('selected'));
    document.querySelectorAll('#telegramDriveList .telegram-drive-item-check').forEach(input => { input.checked = false; });
}

function updateTelegramDriveSelectionBar() {
    const selection = document.getElementById('telegramDriveSelection');
    const count = document.getElementById('telegramDriveSelectionCount');
    if (!selection || !count) return;
    selection.hidden = telegramDriveSelected.size === 0;
    count.textContent = `已选择 ${telegramDriveSelected.size} 项`;
}

function toggleTelegramDriveSelection(item, checked) {
    const key = telegramDriveItemKey(item);
    if (checked) telegramDriveSelected.set(key, item);
    else telegramDriveSelected.delete(key);
    updateTelegramDriveSelectionBar();
}
function selectTelegramDriveItems(invert = false) {
    for (const item of getSortedTelegramDriveItems(telegramDriveCurrentData || {})) {
        const key = telegramDriveItemKey(item);
        if (invert && telegramDriveSelected.has(key)) telegramDriveSelected.delete(key);
        else telegramDriveSelected.set(key, item);
    }
    renderTelegramDriveItems(); updateTelegramDriveSelectionBar();
}
function telegramDriveActionItems(item) {
    return telegramDriveSelected.has(telegramDriveItemKey(item)) ? [...telegramDriveSelected.values()] : [item];
}
async function updateDiskCacheLabels() {
    const files = telegramDriveCurrentData?.files || [];
    const status = await window.TelegramDriveCache?.status(files).catch(() => ({})) || {};
    if (files !== telegramDriveCurrentData?.files) return;
    document.querySelectorAll('#telegramDriveList [data-cache-id]').forEach(link => {
        const cached = Boolean(status[link.dataset.cacheId]);
        link.textContent = cached ? '已缓存到浏览器' : '缓存到浏览器';
        link.classList.toggle('cached', cached); link.setAttribute('aria-disabled', String(cached));
    });
}

function renderTelegramDriveBreadcrumbs(data) {
    const target = document.getElementById('telegramDriveBreadcrumbs');
    const parts = [{ name: '根目录', path: '' }, ...(data.breadcrumbs || [])];
    const nodes = [];
    parts.forEach((part, index) => {
        if (index) { const separator = document.createElement('span'); separator.textContent = '›'; separator.setAttribute('aria-hidden', 'true'); nodes.push(separator); }
        const button = document.createElement('button'); button.type = 'button'; button.textContent = part.name;
        installDiskDrop(button, part.path);
        button.onclick = () => { telegramDrivePath = part.path; clearTelegramDriveSearch(); clearTelegramDriveSelection(); renderTelegramDrive().catch(error => alert(telegramDriveErrorText(error))); };
        nodes.push(button);
    });
    target.replaceChildren(...nodes);
}

function getSortedTelegramDriveItems(data) {
    const query = String(document.getElementById('telegramDriveSearch')?.value || '').trim().toLocaleLowerCase('zh-CN');
    const items = [...(data.folders || []), ...(data.files || [])].filter(item => !query || item.name.toLocaleLowerCase('zh-CN').includes(query));
    const direction = telegramDriveSortAscending ? 1 : -1;
    const value = item => {
        if (telegramDriveSort === 'type') return telegramDriveFileType(item);
        if (telegramDriveSort === 'size') return Number(item.size) || 0;
        if (telegramDriveSort === 'updatedAt') return Number(item.updatedAt || item.createdAt) || 0;
        return item.name;
    };
    return items.sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
        const a = value(left); const b = value(right);
        if (typeof a === 'number' && typeof b === 'number') return (a - b) * direction;
        return String(a).localeCompare(String(b), 'zh-CN', { numeric: true, sensitivity: 'base' }) * direction;
    });
}

function getTelegramDriveItemMeta(item) {
    if (item.kind === 'directory') return `${item.folderCount || 0} 个子目录 · ${item.fileCount || 0} 个文件 · ${formatFileSize(item.size || 0)}`;
    return `${telegramDriveFileType(item)} · ${formatFileSize(item.size || 0)} · ${telegramDriveFormatDate(item.updatedAt || item.createdAt)}`;
}

async function downloadTelegramDriveItem(item) {
    const blob = await window.DiskClient.read(item);
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = item.name; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function checkTelegramDriveItem(item) {
    const result = await telegramDriveRequest(`/api/telegram/drive/files/${encodeURIComponent(item.id)}/check`);
    if (result.valid) return showAppToast('Telegram 文件状态正常');
    const cached = await window.TelegramDriveCache?.get(item.id);
    if (!cached?.blob) return alert('Telegram 文件已失效，当前浏览器没有缓存副本，无法自动修复。');
    if (!await confirmTelegramDriveAction('修复 Telegram 文件', '文件已失效，是否使用本机缓存重新上传到当前网盘分区？', '开始修复')) return;
    await telegramDriveRequest('/api/telegram/drive/files/' + encodeURIComponent(item.id) + '/repair', { method: 'POST', headers: { 'X-Drop2Tunnel-File-Size': String(cached.blob.size), 'Content-Type': 'application/octet-stream' }, body: cached.blob });
    showAppToast('已修复并换绑新的 Telegram 文件');
    await renderTelegramDrive();
}

async function showTelegramDriveProperties(item) {
    const data = item.kind === 'directory'
        ? await telegramDriveRequest(`/api/telegram/drive/directories/properties?path=${encodeURIComponent(item.path)}`)
        : await telegramDriveRequest(`/api/telegram/drive/files/${encodeURIComponent(item.id)}`);
    const entries = item.kind === 'directory'
        ? [['名称', data.name], ['位置', telegramDriveDisplayPath(data.parentPath)], ['类型', '文件夹'], ['内容', `${data.folderCount} 个子目录，${data.fileCount} 个文件`], ['占用空间', formatFileSize(data.size || 0)], ['创建时间', telegramDriveFormatDate(data.createdAt)], ['最后修改', telegramDriveFormatDate(data.updatedAt)]]
        : [['名称', data.name], ['位置', telegramDriveDisplayPath(data.folderPath)], ['类型', telegramDriveFileType(data)], ['大小', `${formatFileSize(data.size || 0)}（${Number(data.size || 0).toLocaleString('zh-CN')} 字节）`], ['创建时间', telegramDriveFormatDate(data.createdAt)], ['最后修改', telegramDriveFormatDate(data.updatedAt)], ['防失联检测', data.lastCheckedAt ? telegramDriveFormatDate(data.lastCheckedAt) : '尚未检测']];
    const dl = document.createElement('dl'); dl.className = 'telegram-drive-property-grid';
    entries.forEach(([name, value]) => { const dt = document.createElement('dt'); dt.textContent = name; const dd = document.createElement('dd'); dd.textContent = value; dl.append(dt, dd); });
    await openTelegramDriveDialog({ title: `“${data.name}”属性`, body: dl, confirmText: '关闭', cancelText: '' });
}

async function renameTelegramDriveItem(item) {
    const name = await promptTelegramDriveText(`重命名${item.kind === 'directory' ? '文件夹' : '文件'}`, item.name, { confirmText: '保存' });
    if (!name || name === item.name) return;
    if (item.kind === 'directory') await telegramDriveRequest('/api/telegram/drive/directories', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: item.path, name }) });
    else await telegramDriveRequest(`/api/telegram/drive/files/${encodeURIComponent(item.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    showAppToast('已重命名');
    await renderTelegramDrive();
}

async function chooseTelegramDriveDestination(items) {
    const root = document.createElement('div'); root.className = 'disk-destination-tree';
    root.setAttribute('role', 'tree');
    const pathInput = document.createElement('input'); pathInput.placeholder = '/音乐/日本/专辑（全路径）'; pathInput.setAttribute('aria-label', '目标目录全路径');
    pathInput.value = telegramDriveDisplayPath(telegramDrivePath); pathInput.maxLength = 2048;
    const create = document.createElement('button'); create.className = 'btn'; create.textContent = '创建多级目录并选中';
    const hint = document.createElement('p'); hint.textContent = '点击选择目标；右键或长按目录可新建子目录。';
    const blocked = path => items.some(item => item.kind === 'directory' && (path === item.path || path.startsWith(item.path + '/')));
    const expanded = new Set(['']);
    function expandParents(path) { const parts = path.split('/'); for (let n = 0; n < parts.length; n++) expanded.add(parts.slice(0, n).join('/')); }
    expandParents(telegramDrivePath);
    function select(path) {
        pathInput.value = telegramDriveDisplayPath(path);
        root.querySelectorAll('[data-folder-path]').forEach(button => button.classList.toggle('selected', button.dataset.folderPath === path));
    }
    function editChild(folder, container) {
        root.querySelector('.disk-folder-editor')?.remove();
        const row = document.createElement('div'); row.className = 'disk-folder-editor';
        const input = document.createElement('input'); input.value = '新建文件夹'; input.setAttribute('aria-label', '子目录名称'); input.maxLength = 100;
        const save = document.createElement('button'); save.type = 'button'; save.textContent = '创建'; save.className = 'btn';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消'; cancel.className = 'btn'; cancel.onclick = () => row.remove();
        save.onclick = async () => {
            if (!input.value.trim()) { input.focus(); return; }
            if (save.disabled) return; save.disabled = true;
            try {
                const result = await telegramDriveRequest('/api/telegram/drive/directories', window.DiskClient.json('POST', { path: [folder.path, input.value.trim()].filter(Boolean).join('/') }));
                pathInput.value = telegramDriveDisplayPath(result.path); expandParents(result.path); await reload();
            } catch (error) { alert(telegramDriveErrorText(error)); } finally { save.disabled = false; }
        };
        row.onkeydown = event => { if (event.isComposing) return; if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (event.key === 'Enter') save.click(); else row.remove(); } };
        row.append('📁', input, save, cancel); container.prepend(row); input.focus(); input.select();
    }
    async function reload() {
        const data = await telegramDriveRequest('/api/telegram/drive/directories');
        root.replaceChildren();
        const children = new Map();
        for (const folder of data.directories) {
            if (blocked(folder.path)) continue;
            const parent = folder.path.split('/').slice(0, -1).join('/');
            if (!children.has(parent)) children.set(parent, []); children.get(parent).push(folder);
        }
        function branch(folder) {
            const details = document.createElement('details'); details.className = 'disk-folder-branch'; details.open = expanded.has(folder.path);
            const summary = document.createElement('summary');
            const button = document.createElement('button'); button.type = 'button'; button.className = 'disk-folder-target'; button.dataset.folderPath = folder.path;
            button.textContent = '📁 ' + folder.name;
            button.onclick = event => { event.preventDefault(); select(folder.path); };
            const nested = document.createElement('div'); nested.className = 'disk-folder-children'; nested.setAttribute('role', 'group');
            summary.append(button); details.append(summary, nested);
            details.ontoggle = () => { if (details.open) expanded.add(folder.path); else expanded.delete(folder.path); };
            for (const child of children.get(folder.path) || []) nested.append(branch(child));
            installContextGesture(button, event => {
                root.querySelector('.disk-tree-menu')?.remove(); select(folder.path);
                const menu = document.createElement('div'); menu.className = 'disk-tree-menu';
                const child = document.createElement('button'); child.type = 'button'; child.textContent = '新建子目录';
                const rect = root.getBoundingClientRect();
                menu.style.left = Math.max(0, Math.min(rect.width - 150, event.clientX - rect.left)) + 'px';
                menu.style.top = Math.max(0, Math.min(rect.height - 44, event.clientY - rect.top)) + root.scrollTop + 'px';
                child.onclick = () => { menu.remove(); details.open = true; expanded.add(folder.path); editChild(folder, nested); };
                menu.append(child); root.append(menu);
            });
            return details;
        }
        root.append(branch({ path: '', name: '根目录' })); select(pathInput.value.replace(/^\/+/, ''));
    }
    root.addEventListener('click', event => { if (!event.target.closest('.disk-tree-menu')) root.querySelector('.disk-tree-menu')?.remove(); });
    create.type = 'button';
    create.onclick = async () => {
        create.disabled = true;
        try {
            const result = await telegramDriveRequest('/api/telegram/drive/directories', window.DiskClient.json('POST', { path: pathInput.value }));
            pathInput.value = telegramDriveDisplayPath(result.path); expandParents(result.path); await reload();
        } catch (error) { alert(telegramDriveErrorText(error)); } finally { create.disabled = false; }
    };
    await reload();
    return openTelegramDriveDialog({ title: '移动到', body: [hint, root, pathInput, create], confirmText: '移动', validate: async () => {
        const safe = pathInput.value.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
        if (blocked(safe)) throw new Error('不能移动到自己或子目录');
        const current = await telegramDriveRequest('/api/telegram/drive/directories');
        if (safe && !current.directories.some(folder => folder.path === safe)) throw new Error('目标目录不存在，请先点击“创建多级目录并选中”');
        return safe;
    } });
}

async function moveTelegramDriveItems(items, targetPath) {
    const destinationPath = targetPath === undefined ? await chooseTelegramDriveDestination(items) : targetPath;
    if (destinationPath === null) return;
    for (const item of items) {
        if (item.kind === 'directory') await telegramDriveRequest('/api/telegram/drive/directories', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: item.path, destinationPath }) });
        else await telegramDriveRequest(`/api/telegram/drive/files/${encodeURIComponent(item.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderPath: destinationPath }) });
    }
    clearTelegramDriveSelection();
    showAppToast(`已移动 ${items.length} 项`);
    await renderTelegramDrive();
}

async function deleteTelegramDriveItems(items) {
    if (!items.length) return;
    const hasDirectory = items.some(item => item.kind === 'directory');
    const message = hasDirectory ? `将删除所选 ${items.length} 项以及文件夹中的全部内容，同时尝试删除 Telegram 存储频道中的文件。此操作不可撤销。` : `将删除所选 ${items.length} 个文件及其 Telegram 存储消息。此操作不可撤销。`;
    if (!await confirmTelegramDriveAction('确认删除', message, '永久删除')) return;
    for (const item of items) {
        if (item.kind === 'directory') await telegramDriveRequest(`/api/telegram/drive/directories?path=${encodeURIComponent(item.path)}&recursive=true`, { method: 'DELETE' });
        else await telegramDriveRequest(`/api/telegram/drive/files/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    }
    clearTelegramDriveSelection();
    showAppToast(`已删除 ${items.length} 项`);
    await renderTelegramDrive();
}

async function copyTelegramDriveItemPath(item) {
    const itemPath = item.kind === 'directory' ? item.path : [item.folderPath, item.name].filter(Boolean).join('/');
    await navigator.clipboard.writeText(telegramDriveDisplayPath(itemPath));
    showAppToast('路径已复制');
}
async function shareDiskItems(items) {
    if (!items.length) return;
    if (!await confirmTelegramDriveAction('创建公开分享', '持有链接的人无需登录即可查看和下载所选内容。目录按当前内容创建快照，之后新增文件不会自动公开；可在“已分享”中停止链接。', '创建分享')) return;
    const share = await telegramDriveRequest('/api/telegram/drive/shares', window.DiskClient.json('POST', { items: items.map(item => item.kind === 'directory' ? { kind: 'directory', path: item.path } : { kind: 'file', id: item.id }) }));
    const input = document.createElement('input'); input.readOnly = true; input.value = new URL(share.url, location.origin).href; input.setAttribute('aria-label', '分享链接');
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn'; copy.textContent = '复制链接';
    copy.onclick = () => navigator.clipboard.writeText(input.value).then(() => showAppToast('分享链接已复制')).catch(() => { input.focus(); input.select(); showAppToast('请手动复制链接'); });
    await openTelegramDriveDialog({ title: '分享已创建', body: [input, copy], confirmText: '完成', cancelText: '' });
}
async function showDiskShares() {
    const body = document.createElement('div'); body.className = 'disk-shares-list';
    async function reload() {
        const data = await telegramDriveRequest('/api/telegram/drive/shares'); body.replaceChildren();
        if (!data.shares.length) { body.textContent = '尚未创建分享'; return; }
        for (const share of data.shares) {
            const row = document.createElement('div'); row.className = 'disk-share-row';
            const title = document.createElement('strong'); title.textContent = share.title;
            const detail = document.createElement('small'); detail.textContent = `${share.fileCount} 个文件 · ${telegramDriveFormatDate(share.createdAt)} · ${share.stoppedAt ? '已停止' : '分享中'}`;
            row.append(title, detail);
            if (!share.stoppedAt) {
                const link = document.createElement('a'); link.href = share.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '打开分享';
                const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn'; copy.textContent = '复制链接';
                copy.onclick = () => navigator.clipboard.writeText(new URL(share.url, location.origin).href).then(() => showAppToast('已复制')).catch(error => alert(telegramDriveErrorText(error)));
                const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'btn'; stop.textContent = '停止分享';
                stop.onclick = async () => {
                    if (!confirm('停止此分享？链接将失效，但不会删除原文件。')) return;
                    stop.disabled = true;
                    try { await telegramDriveRequest('/api/telegram/drive/shares/' + share.id, { method: 'DELETE' }); await reload(); }
                    catch (error) { alert(telegramDriveErrorText(error)); stop.disabled = false; }
                };
                const actions = document.createElement('div'); actions.append(link, copy, stop); row.append(actions);
            }
            body.append(row);
        }
    }
    await reload(); await openTelegramDriveDialog({ title: '已分享', body, confirmText: '关闭', cancelText: '' });
}

function openTelegramDriveItem(item) {
    if (item.kind === 'directory') {
        telegramDrivePath = item.path;
        clearTelegramDriveSearch();
        clearTelegramDriveSelection();
        return renderTelegramDrive();
    }
    return isDiskPreviewable(item) ? openDiskPreview(item) : showTelegramDriveProperties(item);
}

function showTelegramDriveItemMenu(item, anchor) {
    closeTelegramDriveItemMenu();
    telegramDriveMenuItem = item;
    const menu = document.getElementById('telegramDriveItemMenu');
    const chosen = telegramDriveActionItems(item);
    const actions = item.kind === 'directory'
        ? [['打开', () => openTelegramDriveItem(item)], ['重命名', () => renameTelegramDriveItem(item)], ['移动', () => moveTelegramDriveItems([item])], ['复制路径', () => copyTelegramDriveItemPath(item)], ['属性', () => showTelegramDriveProperties(item)], ['删除', () => deleteTelegramDriveItems([item]), true]]
        : [['下载并缓存', () => downloadTelegramDriveItem(item)], ['重命名', () => renameTelegramDriveItem(item)], ['移动', () => moveTelegramDriveItems([item])], ['防失联检测', () => checkTelegramDriveItem(item)], ['复制路径', () => copyTelegramDriveItemPath(item)], ['属性', () => showTelegramDriveProperties(item)], ['删除', () => deleteTelegramDriveItems([item]), true]];
    if (item.kind === 'directory') actions.splice(1, 0, ['新建子目录', () => createTelegramDriveFolder(item.path)]);
    else if (isDiskPreviewable(item)) actions.unshift(['预览', () => openDiskPreview(item)]);
    if (chosen.length > 1) {
        actions.splice(0, actions.length, ['移动所选 ' + chosen.length + ' 项', () => moveTelegramDriveItems(chosen)], ['删除所选 ' + chosen.length + ' 项', () => deleteTelegramDriveItems(chosen), true]);
    }
    if (diskExporter) actions.splice(-1, 0, ['转发到隧道', () => exportDiskItems(chosen)]);
    actions.splice(-1, 0, ['分享', () => shareDiskItems(chosen)]);
    menu.replaceChildren(...actions.map(([label, action, danger]) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; if (danger) button.className = 'danger';
        button.onclick = () => { closeTelegramDriveItemMenu(); Promise.resolve(action()).catch(error => alert(telegramDriveErrorText(error))); };
        return button;
    }));
    menu.hidden = false;
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth || 200; const height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
    menu.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, rect.bottom + 4))}px`;
}

function renderTelegramDriveItems() {
    const list = document.getElementById('telegramDriveList');
    if (!list || !telegramDriveCurrentData) return;
    list.dataset.view = telegramDriveView;
    const items = getSortedTelegramDriveItems(telegramDriveCurrentData);
    if (!items.length) {
        const empty = document.createElement('div'); empty.className = 'telegram-drive-empty'; empty.innerHTML = '<div><div style="font-size:2rem">☁</div><strong>当前目录没有匹配的文件</strong><div>可通过“＋ 新建”上传文件或创建文件夹</div></div>';
        list.replaceChildren(empty); return;
    }
    list.replaceChildren(...items.map(item => {
        const key = telegramDriveItemKey(item);
        const row = document.createElement('div'); row.className = `telegram-drive-item${telegramDriveSelected.has(key) ? ' selected' : ''}`; row.tabIndex = 0;
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'telegram-drive-item-check'; checkbox.checked = telegramDriveSelected.has(key); checkbox.setAttribute('aria-label', `选择 ${item.name}`);
        checkbox.onclick = event => event.stopPropagation(); checkbox.onchange = () => { toggleTelegramDriveSelection(item, checkbox.checked); row.classList.toggle('selected', checkbox.checked); };
        const icon = document.createElement('div'); icon.className = 'telegram-drive-item-icon'; icon.textContent = item.kind === 'directory' ? '📁' : '📄';
        const info = document.createElement('div'); info.className = 'telegram-drive-item-info';
        const name = document.createElement('div'); name.className = 'telegram-drive-item-name'; name.textContent = item.name;
        const meta = document.createElement('div'); meta.className = 'telegram-drive-item-meta'; meta.textContent = getTelegramDriveItemMeta(item); info.append(name, meta);
        if (item.kind !== 'directory') {
            const cache = document.createElement('a'); cache.href = '#'; cache.className = 'disk-cache-link'; cache.dataset.cacheId = item.id; cache.textContent = '缓存到浏览器';
            cache.onclick = async event => {
                event.preventDefault(); event.stopPropagation();
                if (cache.classList.contains('cached') || cache.dataset.busy) return;
                cache.dataset.busy = '1'; cache.textContent = '正在缓存…';
                try {
                    await window.DiskClient.read(item);
                    if (!(await window.TelegramDriveCache?.status([item]))?.[item.id]) throw new Error('浏览器未能保存缓存，请检查存储权限与剩余空间');
                } catch (error) { alert(telegramDriveErrorText(error)); }
                finally { delete cache.dataset.busy; updateDiskCacheLabels(); }
            };
            meta.append(' · ', cache);
        }
        const more = document.createElement('button'); more.type = 'button'; more.className = 'telegram-drive-icon-btn telegram-drive-item-more'; more.textContent = '⋮'; more.setAttribute('aria-label', `${item.name} 更多操作`); more.onclick = event => { event.stopPropagation(); showTelegramDriveItemMenu(item, more); };
        let pointerType = '';
        row.addEventListener('pointerdown', event => { pointerType = event.pointerType; });
        row.onclick = event => {
            if (event.target.closest('input,button,a') || event.detail > 1) return;
            const mouse = pointerType === 'mouse' || (!pointerType && window.matchMedia('(pointer:fine)').matches);
            if (mouse || telegramDriveSelected.size) { checkbox.checked = !checkbox.checked; checkbox.onchange(); }
            else Promise.resolve(openTelegramDriveItem(item)).catch(error => alert(telegramDriveErrorText(error)));
        };
        row.ondblclick = event => {
            if (event.target.closest('input,button,a') || pointerType === 'touch') return;
            event.preventDefault(); Promise.resolve(openTelegramDriveItem(item)).catch(error => alert(telegramDriveErrorText(error)));
        };
        row.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); Promise.resolve(openTelegramDriveItem(item)).catch(error => alert(telegramDriveErrorText(error))); } };
        row.append(checkbox, icon, info, more);
        installContextGesture(row, event => showTelegramDriveItemMenu(item, { getBoundingClientRect: () => ({ right: event.clientX + 180, bottom: event.clientY }) }));
        row.draggable = true;
        row.ondragstart = event => {
            const chosen = telegramDriveSelected.has(key) ? [...telegramDriveSelected.values()] : [item];
            diskDragItems = chosen; event.dataTransfer.setData('application/x-disk-nodes', 'move'); event.dataTransfer.effectAllowed = 'move';
        };
        row.ondragend = () => { diskDragItems = []; };
        if (item.kind === 'directory') installDiskDrop(row, item.path);
        return row;
    }));
    updateDiskCacheLabels();
}

async function uploadFilesToTelegramDrive(fileList) {
    const files = [...(fileList || [])]; if (!files.length) return;
    const result = await window.DiskClient.upload(files, telegramDrivePath);
    showAppToast('已上传 ' + files.length + ' 个文件' + (result.warnings?.length ? '；部分 Telegram 定位备注未能更新，文件索引已保存' : ''));
    await renderTelegramDrive();
}

async function createTelegramDriveFolder(parent = telegramDrivePath) {
    const name = await promptTelegramDriveText('新建文件夹', '', { placeholder: '可使用 / 一次创建多级目录', confirmText: '创建' });
    if (!name) return;
    await telegramDriveRequest('/api/telegram/drive/directories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: [parent, name].filter(Boolean).join('/') }) });
    showAppToast('文件夹已创建');
    await renderTelegramDrive();
}

async function logoutTelegramDrive() {
    if (!await confirmTelegramDriveAction('退出网盘账号', '退出只会清除本浏览器的网盘登录状态，不会删除网盘文件。', '退出账号')) return;
    await telegramDriveRequest('/api/telegram/drive/logout', { method: 'POST' });
    window.DiskClient.stop();
    closeDiskPreview();
    telegramDrivePath = '';
    telegramDriveCurrentData = null;
    clearTelegramDriveSearch();
    clearTelegramDriveSelection();
    await renderTelegramDrive();
    showAppToast('已退出网盘账号');
}

async function renderTelegramDrive() {
    closeTelegramDriveItemMenu();
    const list = document.getElementById('telegramDriveList');
    const workspace = document.getElementById('telegramDriveWorkspace');
    const auth = document.getElementById('telegramDriveAuth');
    const logout = document.getElementById('telegramDriveLogoutBtn');
    const summary = document.getElementById('telegramDriveSummary');
    const sort = document.getElementById('telegramDriveSort'); if (sort) sort.value = telegramDriveSort;
    const direction = document.getElementById('telegramDriveSortDirectionBtn'); if (direction) { direction.textContent = telegramDriveSortAscending ? '↑' : '↓'; direction.setAttribute('aria-label', telegramDriveSortAscending ? '当前升序' : '当前降序'); }
    const view = document.getElementById('telegramDriveViewBtn'); if (view) { view.textContent = telegramDriveView === 'list' ? '▦' : '☷'; view.setAttribute('aria-label', telegramDriveView === 'list' ? '切换为网格视图' : '切换为列表视图'); }
    const status = await window.DiskClient.withActivity('正在加载网盘', getTelegramDriveIdentity);
    logout.hidden = !status.identity;
    if (!status.identity) {
        workspace.hidden = true;
        list.replaceChildren();
        summary.textContent = '尚未登录';
        const isMock = status.oidcMode === 'mock';
        const text = document.createElement('span'); text.textContent = isMock ? '本地开发使用 Telegram OIDC Mock；输入一个模拟 Telegram User ID 即可登录，不会连接 Telegram。' : '使用 Telegram 登录后即可认领和管理自己的网盘文件。';
        const button = document.createElement('button'); button.className = 'btn btn-primary'; button.id = 'telegramDriveLoginBtn'; button.type = 'button'; button.textContent = isMock ? '使用本地 Telegram Mock 登录' : '使用 Telegram 登录'; button.onclick = startTelegramDriveLogin;
        auth.replaceChildren(text);
        if (status.oidcConfigured) auth.append(button);
        if (!isMock) appendPasskeyControls(auth);
        return;
    }
    const notices = [];
    if (!status.enabled) notices.push('管理员尚未启用 Telegram Bot');
    if (!status.configured) notices.push('管理员尚未配置网盘存储频道');
    auth.textContent = `当前账号：${status.identity.name || status.identity.username || status.identity.id}（ID：${status.identity.id}）${notices.length ? `；${notices.join('；')}` : ''}`;
    workspace.hidden = false;
    window.DiskClient.start();
    if (status.oidcMode !== 'mock') appendPasskeyControls(auth, status.identity);
    telegramDriveCurrentData = await telegramDriveRequest(`/api/telegram/drive/list?path=${encodeURIComponent(telegramDrivePath)}`);
    telegramDrivePath = telegramDriveCurrentData.path || '';
    const folderCount = telegramDriveCurrentData.summary?.folderCount || 0;
    const fileCount = telegramDriveCurrentData.summary?.fileCount || 0;
    summary.textContent = `${folderCount} 个文件夹 · ${fileCount} 个文件`;
    renderTelegramDriveBreadcrumbs(telegramDriveCurrentData);
    renderTelegramDriveItems();
    updateTelegramDriveSelectionBar();
}

async function openTelegramDrive() { const overlay = document.getElementById('telegramDriveOverlay'); overlay.hidden = false; overlay.classList.add('active'); await renderTelegramDrive(); }
function closeTelegramDrive() { closeTelegramDriveDialog(null); closeTelegramDriveItemMenu(); const overlay = document.getElementById('telegramDriveOverlay'); overlay.classList.remove('active'); overlay.hidden = true; }
function startTelegramDriveLogin() {
    const target = document.getElementById('telegramDriveAuth');
    if (telegramDriveOidcPopup && !telegramDriveOidcPopup.closed) {
        telegramDriveOidcPopup.focus();
        return;
    }
    const popup = window.open('/api/telegram/drive/oidc/start', 'telegramDriveOidc', 'popup=yes,width=520,height=720,resizable=yes,scrollbars=yes');
    if (!popup) {
        alert('浏览器阻止了 Telegram 登录弹窗。请允许本站弹出窗口后重试；系统不会改用整页跳转。');
        return;
    }
    telegramDriveOidcPopup = popup;
    telegramDriveOidcPollGeneration += 1;
    const generation = telegramDriveOidcPollGeneration;
    if (target) {
        target.innerHTML = '<span>Telegram 登录正在独立窗口中进行，当前隧道与文件传输不会中断。</span> <button class="btn" id="telegramDriveCancelLoginBtn" type="button">取消登录</button>';
        document.getElementById('telegramDriveCancelLoginBtn').onclick = cancelTelegramDriveLogin;
    }
    popup.focus();
    pollTelegramDriveOidcLogin(popup, generation, Date.now()).catch(error => historyLog('telegram-drive-oidc-poll-failed', { error: error.message }));
}

function cancelTelegramDriveLogin() {
    telegramDriveOidcPollGeneration += 1;
    if (telegramDriveOidcPopup && !telegramDriveOidcPopup.closed) telegramDriveOidcPopup.close();
    telegramDriveOidcPopup = null;
    renderTelegramDrive().catch(error => historyLog('telegram-drive-login-cancel-render-failed', { error: error.message }));
}

async function finishTelegramDriveOidcLogin(result, error = '') {
    telegramDriveOidcPollGeneration += 1;
    if (telegramDriveOidcPopup && !telegramDriveOidcPopup.closed) telegramDriveOidcPopup.close();
    telegramDriveOidcPopup = null;
    await renderTelegramDrive();
    if (result === 'success') showAppToast('Telegram 登录成功');
    else alert(`Telegram 登录失败${error ? `：${error}` : '，请重试'}`);
}

async function pollTelegramDriveOidcLogin(popup, generation, startedAt) {
    if (generation !== telegramDriveOidcPollGeneration || popup !== telegramDriveOidcPopup) return;
    const status = await getTelegramDriveIdentity().catch(() => null);
    if (status?.identity) return finishTelegramDriveOidcLogin('success');
    if (status?.oidcMode !== 'mock' && Date.now() - startedAt >= 60000) {
        const text = document.querySelector('#telegramDriveAuth > span');
        if (text) text.textContent = '尚未完成 Telegram 授权。若弹窗提示等待确认但没有通知，请检查已登录的 Telegram 客户端服务通知及网络，或取消后使用 Passkey。本站不能代 Telegram 发出或批准登录确认；管理员可检查 OIDC 阶段日志。';
    }
    if (popup.closed) return finishTelegramDriveOidcLogin('error', '登录窗口已关闭或登录未完成');
    if (Date.now() - startedAt >= 10 * 60 * 1000) return finishTelegramDriveOidcLogin('error', '登录已超时');
    setTimeout(() => pollTelegramDriveOidcLogin(popup, generation, startedAt).catch(error => historyLog('telegram-drive-oidc-poll-failed', { error: error.message })), 2000);
}

function handleTelegramDriveOidcPopupMessage(event) {
    if (event.origin !== window.location.origin || event.source !== telegramDriveOidcPopup || event.data?.type !== 'telegram-drive-oidc-result') return;
    finishTelegramDriveOidcLogin(event.data.result, event.data.error || '').catch(error => {
        historyLog('telegram-drive-oidc-complete-failed', { error: error.message });
        alert(`Telegram 登录状态刷新失败：${error.message}`);
    });
}


let diskExporter = null, diskDragItems = [];
let previewItems = [], previewIndex = 0, previewGeneration = 0, previewURL = '', previewAbort;
const $disk = id => document.getElementById(id);
function appendPasskeyControls(target, user) {
    const group = document.createElement('div'); group.className = 'disk-passkey-controls';
    const input = document.createElement('input'); input.placeholder = '账号名（3–64 位字母、数字、_.-）'; input.autocomplete = 'username webauthn'; input.setAttribute('aria-label', 'Passkey 账号名');
    input.value = user?.username || ''; input.readOnly = Boolean(user?.username);
    group.append(input);
    for (const kind of user ? ['register'] : ['login', 'register']) {
        const button = document.createElement('button'); button.className = 'btn'; button.type = 'button';
        button.textContent = kind === 'login' ? '使用 Passkey 登录' : (user ? '为此账号添加 Passkey' : '注册账号与 Passkey');
        button.onclick = async () => {
            button.disabled = true;
            try {
                if (!window.isSecureContext) throw new Error('Passkey 需要 HTTPS 安全连接');
                if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('当前浏览器不支持 Passkey，请使用支持通行密钥的浏览器');
                if (!window.SimpleWebAuthnBrowser) throw new Error('Passkey 脚本未加载，请管理员检查 /client/simplewebauthn.js 和发布依赖；这不是账号名或 HTTPS 的问题');
                const flow = await window.DiskClient.raw('/passkeys/' + kind + '/options', window.DiskClient.json('POST', { username: input.value }));
                const response = kind === 'login'
                    ? await window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: flow.options })
                    : await window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: flow.options });
                await window.DiskClient.raw('/passkeys/verify', window.DiskClient.json('POST', { flow_id: flow.flow_id, response }));
                await renderTelegramDrive();
            } catch (error) { alert(telegramDriveErrorText(error)); } finally { button.disabled = false; }
        };
        group.append(button);
    }
    target.append(group);
}
function installContextGesture(element, open) {
    let timer, start, suppressUntil = 0;
    const cancel = () => { clearTimeout(timer); timer = null; };
    element.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); cancel(); suppressUntil = Date.now() + 700; open(event); });
    element.addEventListener('pointerdown', event => {
        cancel();
        if (event.pointerType !== 'touch' || !event.isPrimary) return;
        start = { x: event.clientX, y: event.clientY };
        timer = setTimeout(() => { suppressUntil = Date.now() + 1000; open(event); }, 550);
    });
    element.addEventListener('pointermove', event => { if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel(); });
    element.addEventListener('pointerup', cancel); element.addEventListener('pointercancel', cancel);
    element.addEventListener('click', event => { if (Date.now() < suppressUntil) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
}
function installDiskDrop(element, path) {
    element.addEventListener('dragover', event => {
        if (!diskDragItems.length) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'; element.classList.add('disk-drop-target');
    });
    element.addEventListener('dragleave', () => element.classList.remove('disk-drop-target'));
    element.addEventListener('drop', event => {
        event.preventDefault(); event.stopPropagation(); element.classList.remove('disk-drop-target');
        const items = diskDragItems; diskDragItems = [];
        if (items.length) moveTelegramDriveItems(items, path).catch(error => alert(telegramDriveErrorText(error)));
    });
}
async function exportDiskItems(items) {
    const files = new Map();
    for (const item of items) {
        if (item.kind !== 'directory') { if (!files.has(item.id)) files.set(item.id, item); continue; }
        const tree = await telegramDriveRequest('/api/telegram/drive/tree?path=' + encodeURIComponent(item.path));
        for (const file of tree.files) files.set(file.id, { ...file, relativePath: [file.folderPath.slice(item.path.length), file.name].filter(Boolean).join('/').replace(/^\/+/, '') });
    }
    if (!files.size) throw new Error('所选项目没有文件');
    await diskExporter([...files.values()]);
}
function isDiskPreviewable(file) {
    return file.kind !== 'directory' && (/^(image|audio|video|text)\//.test(file.type || '') || file.type === 'application/pdf');
}
function closeDiskPreview() {
    previewGeneration++; previewAbort?.abort();
    const overlay = $disk('diskPreview'); if (!overlay) return;
    overlay.hidden = true; $disk('diskPreviewBody').replaceChildren();
    if (previewURL) URL.revokeObjectURL(previewURL); previewURL = '';
}
async function openDiskPreview(item) {
    previewItems = getSortedTelegramDriveItems(telegramDriveCurrentData).filter(isDiskPreviewable);
    previewIndex = Math.max(0, previewItems.findIndex(file => file.id === item.id));
    $disk('diskPreview').hidden = false;
    return renderDiskPreview();
}
async function renderDiskPreview() {
    const generation = ++previewGeneration;
    previewAbort?.abort(); previewAbort = new AbortController();
    if (previewURL) URL.revokeObjectURL(previewURL); previewURL = '';
    const item = previewItems[previewIndex]; if (!item) return closeDiskPreview();
    $disk('diskPreviewName').textContent = item.name;
    $disk('diskPreviewCount').textContent = (previewIndex + 1) + '/' + previewItems.length;
    $disk('diskPreviewPrev').disabled = previewIndex === 0;
    $disk('diskPreviewNext').disabled = previewIndex === previewItems.length - 1;
    const body = $disk('diskPreviewBody'); body.replaceChildren(); body.textContent = '正在读取文件，可在网盘任务中查看具体阶段…';
    try {
        const blob = await window.DiskClient.read(item, { signal: previewAbort.signal });
        if (generation !== previewGeneration) return;
        // Never execute uploaded HTML/SVG as a same-origin document.
        const type = item.type || blob.type;
        let element;
        if (type.startsWith('text/')) {
            element = document.createElement('pre'); element.textContent = await blob.slice(0, 2 * 1024 * 1024).text();
            if (blob.size > 2 * 1024 * 1024) element.textContent += '\n（仅预览前 2 MB）';
        } else {
            previewURL = URL.createObjectURL(new Blob([blob], { type }));
            if (type.startsWith('image/')) { element = document.createElement('img'); element.alt = item.name; }
            else if (type.startsWith('audio/') || type.startsWith('video/')) { element = document.createElement(type.startsWith('audio/') ? 'audio' : 'video'); element.controls = true; element.autoplay = true; }
            else { element = document.createElement('iframe'); element.setAttribute('sandbox', ''); element.title = item.name; }
            element.src = previewURL;
        }
        if (generation === previewGeneration) body.replaceChildren(element);
    } catch (error) { if (generation === previewGeneration) body.textContent = '预览失败：' + telegramDriveErrorText(error); }
}
function stepDiskPreview(delta) {
    const next = previewIndex + delta;
    if (next < 0 || next >= previewItems.length) return;
    previewIndex = next; renderDiskPreview();
}
function initDiskLoading() {
    const overlay = document.createElement('section'); overlay.id = 'diskLoading'; overlay.hidden = true;
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'diskLoadingTitle');
    overlay.setAttribute('aria-describedby', 'diskLoadingDetail');
    overlay.innerHTML = '<div class="disk-loading-card"><span class="disk-loading-spinner" aria-hidden="true"></span><strong id="diskLoadingTitle"></strong><div id="diskLoadingDetail" role="status" aria-live="polite"></div><progress id="diskLoadingProgress" max="100" aria-label="当前操作进度"></progress><button id="diskLoadingBackground" class="btn btn-secondary" type="button">后台继续</button><small>收起浮层不会取消操作，可在网盘任务中查看进度。</small></div>';
    document.body.append(overlay);
    const title = $disk('diskLoadingTitle'), detail = $disk('diskLoadingDetail');
    const progress = $disk('diskLoadingProgress'), background = $disk('diskLoadingBackground');
    let activities = [], jobs = [], previousFocus, pinnedJob = '';
    const dismissed = new Set();
    function hide() {
        if (overlay.hidden) return;
        const restoreFocus = overlay.contains(document.activeElement);
        overlay.hidden = true;
        if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    }
    function render() {
        const pinned = jobs.find(item => item.operation_id === pinnedJob && ['queued', 'running'].includes(item.status));
        if (!pinned) pinnedJob = '';
        const activity = pinned ? { operationId: pinned.operation_id, message: pinned.title || '正在上传文件' } : activities.find(item => !dismissed.has(item));
        if (!activity) { hide(); return; }
        const job = jobs.find(item => item.operation_id === activity.operationId && ['queued', 'running'].includes(item.status));
        title.textContent = activity.message;
        const percent = typeof job?.percent === 'number' && Number.isFinite(job.percent) ? Math.max(0, Math.min(100, job.percent)) : null;
        detail.textContent = job ? [job.message, job.phase, percent === null ? '' : Math.round(percent) + '%', job.totalBytes ? formatFileSize(job.processedBytes) + ' / ' + formatFileSize(job.totalBytes) : ''].filter(Boolean).join(' · ') : '正在处理，请稍候…';
        if (percent === null) progress.removeAttribute('value'); else progress.value = percent;
        if (overlay.hidden) { previousFocus = document.activeElement; overlay.hidden = false; background.focus({ preventScroll: true }); }
    }
    background.onclick = () => { pinnedJob = ''; activities.forEach(item => dismissed.add(item)); hide(); };
    // Do not let Enter/Escape/arrows reach the preview or the underlying edit dialog.
    document.addEventListener('keydown', event => {
        if (overlay.hidden) return;
        event.stopImmediatePropagation();
        if (event.key === 'Escape') { event.preventDefault(); background.click(); }
        else if (event.key === 'Tab') { event.preventDefault(); background.focus(); }
        else if (event.target !== background) event.preventDefault();
    }, true);
    document.addEventListener('focusin', event => { if (!overlay.hidden && !overlay.contains(event.target)) background.focus({ preventScroll: true }); });
    window.DiskClient.subscribeActivity(value => {
        activities = value;
        for (const item of dismissed) if (!activities.includes(item)) dismissed.delete(item);
        render();
    });
    window.DiskClient.subscribe(value => { jobs = value; render(); });
    return () => {
        const job = jobs.find(item => item.type === 'upload' && ['queued', 'running'].includes(item.status));
        if (!job) return false;
        for (const activity of activities) if (activity.operationId === job.operation_id) dismissed.delete(activity);
        pinnedJob = job.operation_id; render(); return true;
    };
}
function renderDiskTaskBubble(bubble, jobs) {
    const uploads = jobs.filter(job => job.type === 'upload' && ['queued', 'running', 'failed'].includes(job.status));
    // A failed upload stays visible even if another upload is running or has completed.
    const job = uploads.find(item => item.status === 'failed') || uploads[0];
    bubble.hidden = !job;
    if (!job) return;
    const failed = job.status === 'failed';
    bubble.title = failed ? '上传失败，点击查看详情：' + telegramDriveErrorText(job.errorCode) : job.message;
    bubble.classList.toggle('failed', failed);
    bubble.classList.toggle('indeterminate', !failed && job.percent === null);
    bubble.style.setProperty('--progress', failed ? '360deg' : (Number(job.percent ?? job.lastMeasuredPercent) || 0) * 3.6 + 'deg');
    bubble.querySelector('small').textContent = failed ? '!' : uploads.length;
}
function positionDiskTaskBubble(bubble, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    bubble.style.left = Math.max(left + 8, Math.min(left + width - 72, x)) + 'px';
    bubble.style.top = Math.max(top + 8, Math.min(top + height - 72, y)) + 'px';
    bubble.style.right = 'auto'; bubble.style.bottom = 'auto';
}
function initDiskEnhancements() {
    const restoreLoading = initDiskLoading();
    const tasks = document.createElement('details'); tasks.id = 'diskTasks'; tasks.className = 'disk-tasks';
    tasks.innerHTML = '<summary>网盘任务 <span id="diskTaskCount"></span></summary><div id="diskTaskList" aria-live="polite"></div>';
    $disk('telegramDriveAuth').after(tasks);
    const bubble = document.createElement('button'); bubble.id = 'diskTaskBubble'; bubble.type = 'button'; bubble.hidden = true; bubble.setAttribute('aria-label', '查看网盘任务');
    bubble.innerHTML = '<span>☁</span><small></small>'; document.body.append(bubble);
    const preview = document.createElement('section'); preview.id = 'diskPreview'; preview.hidden = true; preview.setAttribute('role', 'dialog'); preview.setAttribute('aria-modal', 'true');
    preview.innerHTML = '<header><strong id="diskPreviewName"></strong><button id="diskPreviewClose" aria-label="关闭预览">×</button></header><div id="diskPreviewBody"></div><footer><button id="diskPreviewPrev" aria-label="上一个文件">←</button><span id="diskPreviewCount"></span><button id="diskPreviewNext" aria-label="下一个文件">→</button></footer>';
    document.body.append(preview);
    $disk('diskPreviewClose').onclick = closeDiskPreview; $disk('diskPreviewPrev').onclick = () => stepDiskPreview(-1); $disk('diskPreviewNext').onclick = () => stepDiskPreview(1);
    document.addEventListener('keydown', event => {
        if (preview.hidden || event.target.matches('input,textarea,select') || event.isComposing) return;
        if (event.key === 'Escape') closeDiskPreview();
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); stepDiskPreview(event.key === 'ArrowLeft' ? -1 : 1); }
    });
    let touch;
    preview.addEventListener('touchstart', event => { touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null; }, { passive: true });
    preview.addEventListener('touchmove', event => { if (event.touches.length !== 1) touch = null; }, { passive: true });
    preview.addEventListener('touchend', event => {
        if (!touch || !event.changedTouches.length) return;
        const dx = event.changedTouches[0].clientX - touch.x, dy = event.changedTouches[0].clientY - touch.y; touch = null;
        if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.5) stepDiskPreview(dx < 0 ? 1 : -1);
    }, { passive: true });
    const forward = document.createElement('button'); forward.className = 'btn btn-secondary'; forward.id = 'diskBatchForward'; forward.textContent = '转发到隧道';
    forward.onclick = () => exportDiskItems([...telegramDriveSelected.values()]).catch(error => alert(telegramDriveErrorText(error)));
    $disk('telegramDriveBatchMoveBtn').before(forward);
    for (const [label, action] of [['全选', () => selectTelegramDriveItems()], ['反选', () => selectTelegramDriveItems(true)], ['分享所选', () => shareDiskItems([...telegramDriveSelected.values()])]]) {
        const button = document.createElement('button'); button.className = 'btn btn-secondary'; button.textContent = label;
        button.onclick = () => Promise.resolve(action()).catch(error => alert(telegramDriveErrorText(error)));
        $disk('telegramDriveBatchMoveBtn').before(button);
    }
    const shares = document.createElement('button'); shares.className = 'btn btn-secondary'; shares.textContent = '已分享'; shares.onclick = () => showDiskShares().catch(error => alert(telegramDriveErrorText(error)));
    $disk('telegramDriveRefreshBtn').before(shares);
    let drag, moved = false;
    const position = (x, y) => positionDiskTaskBubble(bubble, x, y);
    const keepVisible = () => {
        if (bubble.hidden) return;
        const rect = bubble.getBoundingClientRect(); position(rect.left, rect.top);
    };
    window.addEventListener('resize', keepVisible);
    window.visualViewport?.addEventListener('resize', keepVisible);
    window.visualViewport?.addEventListener('scroll', keepVisible);
    try { const saved = JSON.parse(localStorage.getItem('disk-task-position')); if (saved) position(saved.x, saved.y); } catch (_) {}
    bubble.onpointerdown = event => { const rect = bubble.getBoundingClientRect(); drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }; moved = false; bubble.setPointerCapture(event.pointerId); };
    bubble.onpointermove = event => { if (!drag) return; const dx = event.clientX - drag.x, dy = event.clientY - drag.y; if (Math.hypot(dx, dy) > 5) moved = true; if (moved) position(drag.left + dx, drag.top + dy); };
    bubble.onpointerup = () => { drag = null; const rect = bubble.getBoundingClientRect(); localStorage.setItem('disk-task-position', JSON.stringify({ x: rect.left, y: rect.top })); };
    bubble.onpointercancel = () => { drag = null; moved = true; };
    bubble.onclick = async () => {
        if (moved) return;
        closeDiskPreview();
        if (!bubble.classList.contains('failed')) restoreLoading();
        try {
            if ($disk('telegramDriveOverlay').hidden) await openTelegramDrive();
            tasks.open = true; tasks.scrollIntoView({ block: 'nearest' });
        }
        catch (error) { alert(telegramDriveErrorText(error)); }
    };
    window.DiskClient.subscribe(jobs => {
        const ongoing = jobs.filter(job => ['queued', 'running'].includes(job.status));
        $disk('diskTaskCount').textContent = ongoing.length ? '· ' + ongoing.length + ' 项进行中' : '';
        $disk('diskTaskList').replaceChildren(...jobs.slice(0, 30).map(job => {
            const row = document.createElement('div'); row.className = 'disk-task-row';
            const title = document.createElement('strong'); title.textContent = (job.title ? job.title + ' · ' : '') + job.message;
            const detail = document.createElement('span'); detail.textContent = job.phase + ' · ' + (job.percent === null ? '处理中（进度未定）' : Math.round(job.percent) + '%') + (job.totalBytes ? ' · ' + formatFileSize(job.processedBytes) + '/' + formatFileSize(job.totalBytes) : '') + (job.errorCode ? ' · ' + telegramDriveErrorText(job.errorCode) : '');
            if (job.warnings?.length) detail.textContent += ' · 文件已保存，部分 Telegram 定位备注未能更新';
            row.append(title, detail); return row;
        }));
        tasks.hidden = !jobs.length;
        renderDiskTaskBubble(bubble, jobs);
        keepVisible();
    });
    getTelegramDriveIdentity().then(status => { if (status.identity) window.DiskClient.start(); }).catch(() => {});
}
function init(options = {}) {
    ({ formatFileSize = formatFileSize, showAppToast = showAppToast, historyLog = historyLog } = options);
    window.addEventListener('message', handleTelegramDriveOidcPopupMessage);
    window.addEventListener('disk-cache-changed', updateDiskCacheLabels);
    window.addEventListener('focus', updateDiskCacheLabels);
    document.getElementById('closeTelegramDriveBtn')?.addEventListener('click', closeTelegramDrive);
    document.getElementById('telegramDriveDialogCloseBtn')?.addEventListener('click', () => closeTelegramDriveDialog(null));
    document.getElementById('telegramDriveRefreshBtn')?.addEventListener('click', () => renderTelegramDrive().catch(error => alert(telegramDriveErrorText(error))));
    document.getElementById('telegramDriveLogoutBtn')?.addEventListener('click', () => logoutTelegramDrive().catch(error => alert(telegramDriveErrorText(error))));
    document.getElementById('telegramDriveSearch')?.addEventListener('input', renderTelegramDriveItems);
    document.getElementById('telegramDriveSort')?.addEventListener('change', event => {
        telegramDriveSort = event.target.value;
        localStorage.setItem('telegram-drive-sort', telegramDriveSort);
        renderTelegramDriveItems();
    });
    document.getElementById('telegramDriveSortDirectionBtn')?.addEventListener('click', event => {
        telegramDriveSortAscending = !telegramDriveSortAscending;
        localStorage.setItem('telegram-drive-sort-ascending', String(telegramDriveSortAscending));
        event.currentTarget.textContent = telegramDriveSortAscending ? '↑' : '↓';
        event.currentTarget.setAttribute('aria-label', telegramDriveSortAscending ? '当前升序' : '当前降序');
        renderTelegramDriveItems();
    });
    document.getElementById('telegramDriveViewBtn')?.addEventListener('click', event => {
        telegramDriveView = telegramDriveView === 'list' ? 'grid' : 'list';
        localStorage.setItem('telegram-drive-view', telegramDriveView);
        event.currentTarget.textContent = telegramDriveView === 'list' ? '▦' : '☷';
        event.currentTarget.setAttribute('aria-label', telegramDriveView === 'list' ? '切换为网格视图' : '切换为列表视图');
        renderTelegramDriveItems();
    });
    document.getElementById('telegramDriveCreateBtn')?.addEventListener('click', event => {
        event.stopPropagation();
        const menu = document.getElementById('telegramDriveCreateMenu');
        menu.hidden = !menu.hidden;
    });
    document.getElementById('telegramDriveUploadBtn')?.addEventListener('click', () => {
        document.getElementById('telegramDriveCreateMenu').hidden = true;
        document.getElementById('telegramDriveFileInput').click();
    });
    document.getElementById('telegramDriveNewFolderBtn')?.addEventListener('click', () => {
        document.getElementById('telegramDriveCreateMenu').hidden = true;
        createTelegramDriveFolder().catch(error => alert(telegramDriveErrorText(error)));
    });
    document.getElementById('telegramDriveFileInput')?.addEventListener('change', event => {
        const files = [...event.target.files]; event.target.value = '';
        uploadFilesToTelegramDrive(files).catch(error => { alert(telegramDriveErrorText(error)); renderTelegramDrive().catch(() => {}); });
    });
    document.getElementById('telegramDriveClearSelectionBtn')?.addEventListener('click', clearTelegramDriveSelection);
    document.getElementById('telegramDriveBatchMoveBtn')?.addEventListener('click', () => moveTelegramDriveItems([...telegramDriveSelected.values()]).catch(error => alert(telegramDriveErrorText(error))));
    document.getElementById('telegramDriveBatchDeleteBtn')?.addEventListener('click', () => deleteTelegramDriveItems([...telegramDriveSelected.values()]).catch(error => alert(telegramDriveErrorText(error))));
    document.addEventListener('click', event => {

        if (!event.target.closest?.('.telegram-drive-create-wrap')) {
            const menu = document.getElementById('telegramDriveCreateMenu');
            if (menu) menu.hidden = true;
        }
        if (!event.target.closest?.('#telegramDriveItemMenu,.telegram-drive-item-more')) closeTelegramDriveItemMenu();
    });
    initDiskEnhancements();
}
window.DiskUI = { init, open: openTelegramDrive, close: closeTelegramDrive, upload: uploadFilesToTelegramDrive, render: renderTelegramDrive, prompt: promptTelegramDriveText, setExporter(fn) { diskExporter = fn; }, get path() { return telegramDrivePath; } };
})();
