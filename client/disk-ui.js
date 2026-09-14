'use strict';
// Standalone drive UI: no tunnel/session/collection dependencies.
(function () {
let formatFileSize = value => value + ' B', showAppToast = message => alert(message), historyLog = () => {}, loadAudioCover = null;
let telegramDrivePath = '';
let telegramDriveNavigationVersion = 0;
let telegramDriveOidcPopup = null;
let telegramDriveOidcPollGeneration = 0;
let telegramDriveCurrentData = null;
let telegramDriveSearchData = null;
let telegramDriveSearchTimer = 0;
let telegramDriveSearchGeneration = 0;
let telegramDriveSearchAbort;
let telegramDriveRenderGeneration = 0;
let telegramDriveHistorySession = '';
let telegramDriveInitialized = false;
let telegramDriveMenuItem = null;
let telegramDriveMenuHistoryOpen = false;
let telegramDriveMenuHistoryClosing = false;
let telegramDriveMenuPendingAction = null;
let telegramDriveDialogHistoryOpen = false;
let telegramDriveDialogHistoryClosing = false;
let telegramDriveContentStale = false;
let telegramDriveSelectionAnchor = '';
const telegramDriveSelected = new Map();
const telegramDriveCacheCancelConfirming = new Set();
let telegramDriveView = localStorage.getItem('telegram-drive-view') === 'grid' ? 'grid' : 'list';
let telegramDriveSort = localStorage.getItem('telegram-drive-sort') || 'name';
let telegramDriveSortAscending = localStorage.getItem('telegram-drive-sort-ascending') !== 'false';
const diskWindowKey = 'telegram-drive-window';
let diskWindowState = {};
try { diskWindowState = JSON.parse(localStorage.getItem(diskWindowKey)) || {}; } catch (_) {}
if (diskWindowState.retained) telegramDrivePath = String(diskWindowState.path || '');
function saveDiskWindow(retained) {
    diskWindowState = { retained, path: telegramDrivePath };
    localStorage.setItem(diskWindowKey, JSON.stringify(diskWindowState));
    const button = document.getElementById('topbarDiskBtn'); if (button) button.hidden = !retained;
}
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
        'TELEGRAM_DELETE_NOT_PERMITTED': 'Telegram 拒绝删除或替换消息，请检查频道权限及消息类型',
        'TELEGRAM_CAPTION_SYNC_PENDING': '目录/名称已保存，部分 Telegram 备注同步失败，服务器将自动重试',
        'TELEGRAM_UPLOAD_RESULT_INVALID': 'Telegram 返回的消息缺少有效文件定位信息，上传未完成',
        'TELEGRAM_413': 'Telegram 拒绝当前上传请求的大小，请重试或检查 Bot API 代理限制',
        'TELEGRAM_PARTS_INVALID': '文件分片索引不完整，无法还原文件',
        'TELEGRAM_MESSAGE_MISSING': '文件索引缺少 Telegram 消息定位信息，无法删除实体',
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
    telegramDriveSearchData = null;
    telegramDriveSearchGeneration++;
    clearTimeout(telegramDriveSearchTimer);
    telegramDriveSearchAbort?.abort();
    document.getElementById('telegramDriveSearchSpinner')?.setAttribute('hidden', '');
}
function telegramDriveFileType(item) {
    if (item.kind === 'directory') return '文件夹';
    const type = String(item.type || 'application/octet-stream');
    return type === 'application/octet-stream' ? '文件' : type;
}

function closeTelegramDriveItemMenu({ fromHistory = false, replaceHistory = false } = {}) {
    const menu = document.getElementById('telegramDriveItemMenu');
    if (menu) { menu.hidden = true; menu.replaceChildren(); }
    const backdrop = document.getElementById('telegramDriveItemMenuBackdrop');
    if (backdrop) backdrop.hidden = true;
    telegramDriveMenuItem = null;
    if (!telegramDriveMenuHistoryOpen) return;
    if (fromHistory) {
        telegramDriveMenuHistoryOpen = false;
        telegramDriveMenuHistoryClosing = false;
        const action = telegramDriveMenuPendingAction; telegramDriveMenuPendingAction = null;
        if (action) Promise.resolve().then(action);
        return;
    }
    if (replaceHistory) {
        const next = { ...(history.state || {}) }; delete next.telegramDriveMenu;
        history.replaceState(next, '', location.href);
        telegramDriveMenuHistoryOpen = false; telegramDriveMenuHistoryClosing = false; telegramDriveMenuPendingAction = null;
    } else if (history.state?.telegramDriveMenu && !telegramDriveMenuHistoryClosing) {
        telegramDriveMenuHistoryClosing = true;
        history.back();
    } else if (!history.state?.telegramDriveMenu) {
        telegramDriveMenuHistoryOpen = false; telegramDriveMenuHistoryClosing = false;
    }
}

function closeTelegramDriveDialog(result = null, { fromHistory = false, replaceHistory = false } = {}) {
    const dialog = document.getElementById('telegramDriveDialog');
    if (!dialog) return;
    const resolver = dialog._telegramDriveResolver;
    dialog._telegramDriveResolver = null;
    dialog.hidden = true;
    dialog.onkeydown = null;
    delete dialog.dataset.dismissOnBackdrop;
    document.getElementById('telegramDriveDialogBody')?.replaceChildren();
    document.getElementById('telegramDriveDialogActions')?.replaceChildren();
    if (resolver) resolver(result);
    if (!telegramDriveDialogHistoryOpen) return;
    if (fromHistory) { telegramDriveDialogHistoryOpen = false; telegramDriveDialogHistoryClosing = false; return; }
    if (replaceHistory) {
        const next = { ...(history.state || {}) }; delete next.telegramDriveDialog;
        history.replaceState(next, '', location.href);
        telegramDriveDialogHistoryOpen = false; telegramDriveDialogHistoryClosing = false;
    } else if (history.state?.telegramDriveDialog && !telegramDriveDialogHistoryClosing) {
        telegramDriveDialogHistoryClosing = true;
        history.back();
    } else if (!history.state?.telegramDriveDialog) {
        telegramDriveDialogHistoryOpen = false; telegramDriveDialogHistoryClosing = false;
    }
}

function openTelegramDriveDialog({ title, body, confirmText = '确定', confirmClass = 'btn-primary', cancelText = '取消', validate, historyEntry = false, dismissOnBackdrop = false } = {}) {
    const dialog = document.getElementById('telegramDriveDialog');
    const titleEl = document.getElementById('telegramDriveDialogTitle');
    const bodyEl = document.getElementById('telegramDriveDialogBody');
    const actions = document.getElementById('telegramDriveDialogActions');
    closeTelegramDriveItemMenu({ replaceHistory: true });
    titleEl.textContent = title || 'Telegram网盘';
    bodyEl.replaceChildren(...(Array.isArray(body) ? body : [body]).filter(Boolean));
    actions.replaceChildren();
    const cancel = cancelText ? document.createElement('button') : null;
    if (cancel) { cancel.className = 'btn btn-secondary'; cancel.type = 'button'; cancel.textContent = cancelText; }
    const confirm = document.createElement('button'); confirm.className = `btn ${confirmClass}`; confirm.type = 'button'; confirm.textContent = confirmText;
    if (cancel) actions.append(cancel);
    actions.append(confirm);
    if (historyEntry && !history.state?.telegramDriveDialog) history.pushState({ ...(history.state || {}), telegramDriveDialog: true }, '', location.href);
    telegramDriveDialogHistoryOpen = Boolean(historyEntry);
    telegramDriveDialogHistoryClosing = false;
    dialog.dataset.dismissOnBackdrop = dismissOnBackdrop ? 'true' : 'false';
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
    telegramDriveSelectionAnchor = '';
    updateTelegramDriveSelectionBar();
    document.querySelectorAll('#telegramDriveList .telegram-drive-item').forEach(row => row.classList.remove('selected'));
    document.querySelectorAll('#telegramDriveList .telegram-drive-item-check').forEach(input => { input.checked = false; });
}

function updateTelegramDriveSelectionBar() {
    const selection = document.getElementById('telegramDriveSelection');
    const count = document.getElementById('telegramDriveSelectionCount');
    if (!selection || !count) return;
    selection.hidden = telegramDriveSelected.size === 0;
    document.querySelector('.telegram-drive-manager')?.classList.toggle('telegram-drive-has-selection', telegramDriveSelected.size > 0);
    count.textContent = `已选择 ${telegramDriveSelected.size} 项`;
}

function toggleTelegramDriveSelection(item, checked, { renderBar = true } = {}) {
    const key = telegramDriveItemKey(item);
    if (checked) telegramDriveSelected.set(key, item);
    else telegramDriveSelected.delete(key);
    document.querySelector('.telegram-drive-manager')?.classList.toggle('telegram-drive-has-selection', telegramDriveSelected.size > 0);
    if (renderBar) updateTelegramDriveSelectionBar();
}
function updateTelegramDriveBottomSummary(data = telegramDriveCurrentData) {
    const target = document.getElementById('telegramDriveBottomSummary');
    if (!target) return;
    const folders = Number(data?.summary?.folderCount ?? data?.directories?.length) || 0;
    const files = Number(data?.summary?.fileCount ?? data?.files?.length) || 0;
    const bytes = (data?.files || []).reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    target.textContent = `${folders} 个文件夹 · ${files} 个文件 · 合计 ${formatFileSize(bytes)}`;
}
function selectTelegramDriveItems(invert = false) {
    for (const item of getSortedTelegramDriveItems(getTelegramDriveDisplayData())) {
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
    const data = getTelegramDriveDisplayData();
    const files = data?.files || [];
    const status = await window.TelegramDriveCache?.status(files).catch(() => ({})) || {};
    if (files !== getTelegramDriveDisplayData()?.files) return;
    document.querySelectorAll('#telegramDriveList [data-cache-id]').forEach(link => {
        const cached = Boolean(status[link.dataset.cacheId]);
        link.textContent = cached ? '已缓存到浏览器' : '缓存到浏览器';
        link.classList.toggle('cached', cached); link.setAttribute('aria-disabled', String(cached));
    });
    document.querySelectorAll('#telegramDriveList [data-cache-indicator]').forEach(badge => {
        const cached = Boolean(status[badge.dataset.cacheIndicator]);
        const pending = window.DiskClient.isCaching(badge.dataset.cacheIndicator);
        const progress = window.DiskClient.cacheProgress?.(badge.dataset.cacheIndicator);
        badge.hidden = !cached && !pending;
        badge.classList.toggle('pending', pending);
        badge.textContent = pending && Number.isFinite(progress?.percent) ? Math.round(progress.percent) + '%' : (pending ? '' : '↓');
        badge.title = pending ? (Number.isFinite(progress?.percent) ? `正在缓存到浏览器 · ${Math.round(progress.percent)}%` : '正在缓存到浏览器') : '已缓存到浏览器';
        badge.setAttribute('aria-label', badge.title);
    });
}

function renderTelegramDriveBreadcrumbs(data) {
    const target = document.getElementById('telegramDriveBreadcrumbs');
    const parts = [{ name: '根目录', path: '' }, ...(data.breadcrumbs || [])];
    const nodes = [];
    parts.forEach((part, index) => {
        if (index) { const separator = document.createElement('span'); separator.textContent = '›'; separator.setAttribute('aria-hidden', 'true'); nodes.push(separator); }
        const button = document.createElement('button'); button.type = 'button'; button.textContent = part.name;
        if (index === parts.length - 1) button.setAttribute('aria-current', 'page');
        installDiskDrop(button, part.path);
        button.onclick = () => navigateTelegramDrive(part.path).catch(error => alert(telegramDriveErrorText(error)));
        nodes.push(button);
    });
    target.replaceChildren(...nodes);
    requestAnimationFrame(() => { target.scrollLeft = target.scrollWidth; });
}

function initDiskBreadcrumbScroll() {
    const target = document.getElementById('telegramDriveBreadcrumbs');
    let frame = 0, direction = 0, previous = 0;
    const stop = () => { cancelAnimationFrame(frame); frame = 0; direction = 0; previous = 0; };
    const tick = time => {
        if (!direction || document.getElementById('telegramDriveOverlay').hidden) return stop();
        const before = target.scrollLeft;
        target.scrollLeft += direction * 180 * Math.min(previous ? (time - previous) / 1000 : 0, .05);
        previous = time;
        if (before === target.scrollLeft && (direction < 0 ? before <= 0 : before >= target.scrollWidth - target.clientWidth - 1)) return stop();
        frame = requestAnimationFrame(tick);
    };
    target.addEventListener('pointermove', event => {
        if (event.pointerType !== 'mouse') return;
        const rect = target.getBoundingClientRect(), edge = Math.min(48, rect.width / 4);
        const next = event.clientX < rect.left + edge ? -1 : event.clientX > rect.right - edge ? 1 : 0;
        if (!next) return stop();
        direction = next;
        if (!frame) frame = requestAnimationFrame(tick);
    });
    target.addEventListener('pointerleave', stop);
    target.addEventListener('pointerdown', stop);
    window.addEventListener('blur', stop);
    new ResizeObserver(() => { if (!direction) target.scrollLeft = target.scrollWidth; }).observe(target);
}

function getSortedTelegramDriveItems(data) {
    const query = String(document.getElementById('telegramDriveSearch')?.value || '').trim().toLocaleLowerCase('zh-CN');
    const global = Boolean(document.getElementById('telegramDriveSearchAll')?.checked);
    const items = [...(data?.folders || []), ...(data?.files || [])].filter(item => global || !query || item.name.toLocaleLowerCase('zh-CN').includes(query));
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

function getTelegramDriveDisplayData() {
    const query = String(document.getElementById('telegramDriveSearch')?.value || '').trim();
    return document.getElementById('telegramDriveSearchAll')?.checked && query ? (telegramDriveSearchData || { folders: [], files: [] }) : (telegramDriveCurrentData || { folders: [], files: [] });
}

function scheduleTelegramDriveSearch() {
    clearTimeout(telegramDriveSearchTimer);
    telegramDriveSearchAbort?.abort();
    const spinner = document.getElementById('telegramDriveSearchSpinner');
    if (spinner) spinner.hidden = true;
    const input = document.getElementById('telegramDriveSearch');
    const global = document.getElementById('telegramDriveSearchAll');
    const query = String(input?.value || '').trim();
    if (input) {
        input.placeholder = global?.checked ? '搜索所有目录与文件' : '搜索当前目录';
        input.setAttribute('aria-label', input.placeholder);
    }
    if (!global?.checked || !query) {
        telegramDriveSearchData = null;
        telegramDriveSearchGeneration++;
        renderTelegramDriveItems();
        return;
    }
    const generation = ++telegramDriveSearchGeneration;
    const controller = new AbortController(); telegramDriveSearchAbort = controller;
    if (spinner) spinner.hidden = false;
    telegramDriveSearchTimer = setTimeout(async () => {
        try {
            const result = await window.DiskClient.raw('/search?q=' + encodeURIComponent(query), { signal: controller.signal });
            if (generation !== telegramDriveSearchGeneration || query !== String(input?.value || '').trim() || !global.checked) return;
            telegramDriveSearchData = result;
            renderTelegramDriveItems();
        } catch (error) { if (generation === telegramDriveSearchGeneration && error.name !== 'AbortError') showAppToast('搜索失败：' + telegramDriveErrorText(error)); }
        finally { if (generation === telegramDriveSearchGeneration && spinner) spinner.hidden = true; }
    }, 180);
}

function getTelegramDriveItemMeta(item) {
    const global = document.getElementById('telegramDriveSearchAll')?.checked && String(document.getElementById('telegramDriveSearch')?.value || '').trim();
    const location = global ? `位置：${telegramDriveDisplayPath(item.kind === 'directory' ? item.parentPath : item.folderPath)} · ` : '';
    if (item.kind === 'directory' && item.reviewStatus === 'deleted') return `${location}已被管理员删除目录内容 · 仅保留节点 · ${telegramDriveFormatDate(item.reviewUpdatedAt)}`;
    if (item.kind === 'directory' && item.reviewStatus === 'blocked') return `${location}已被管理员屏蔽 · 仅自己可见且不可分享 · ${item.folderCount || 0} 个子目录 · ${item.fileCount || 0} 个文件`;
    if (item.kind === 'directory') return `${location}${item.folderCount || 0} 个子目录 · ${item.fileCount || 0} 个文件 · ${formatFileSize(item.size || 0)}`;
    if (item.reviewStatus === 'deleted') return `${location}已被管理员删除文件实体 · 仅保留节点 · ${telegramDriveFormatDate(item.reviewUpdatedAt)}`;
    if (item.reviewStatus === 'blocked') return `${location}已被管理员屏蔽 · 仅自己可见且不可分享 · ${telegramDriveFileType(item)} · ${formatFileSize(item.size || 0)}`;
    return `${location}${telegramDriveFileType(item)} · ${formatFileSize(item.size || 0)} · ${telegramDriveFormatDate(item.updatedAt || item.createdAt)}`;
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
        ? [['名称', data.name], ['位置', telegramDriveDisplayPath(data.parentPath)], ['类型', '文件夹'], ['审核状态', data.reviewStatus === 'deleted' ? '目录内容已删除，仅保留节点' : data.reviewStatus === 'blocked' ? '已屏蔽，仅自己可见且不可分享' : '正常'], ['内容', `${data.folderCount} 个子目录，${data.fileCount} 个文件`], ['占用空间', formatFileSize(data.size || 0)], ['创建时间', telegramDriveFormatDate(data.createdAt)], ['最后修改', telegramDriveFormatDate(data.updatedAt)]]
        : [['名称', data.name], ['位置', telegramDriveDisplayPath(data.folderPath)], ['类型', telegramDriveFileType(data)], ['审核状态', data.reviewStatus === 'deleted' ? '文件实体已删除，仅保留节点' : data.reviewStatus === 'blocked' ? '已屏蔽，仅自己可见且不可分享' : '正常'], ['大小', `${formatFileSize(data.size || 0)}（${Number(data.size || 0).toLocaleString('zh-CN')} 字节）`], ['创建时间', telegramDriveFormatDate(data.createdAt)], ['最后修改', telegramDriveFormatDate(data.updatedAt)], ['防失联检测', data.lastCheckedAt ? telegramDriveFormatDate(data.lastCheckedAt) : '尚未检测']];
    const dl = document.createElement('dl'); dl.className = 'telegram-drive-property-grid';
    entries.forEach(([name, value]) => { const dt = document.createElement('dt'); dt.textContent = name; const dd = document.createElement('dd'); dd.textContent = value; dl.append(dt, dd); });
    await openTelegramDriveDialog({ title: `“${data.name}”属性`, body: dl, confirmText: '关闭', cancelText: '', historyEntry: true, dismissOnBackdrop: true });
}

async function renameTelegramDriveItem(item) {
    const name = await promptTelegramDriveText(`重命名${item.kind === 'directory' ? '文件夹' : '文件'}`, item.name, { confirmText: '保存' });
    if (!name || name === item.name) return;
    if (item.kind === 'directory') await telegramDriveRequest('/api/telegram/drive/directories', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: item.path, name }) });
    else await telegramDriveRequest(`/api/telegram/drive/files/${encodeURIComponent(item.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    showAppToast('已重命名');
    await renderTelegramDrive();
}

async function chooseTelegramDriveDestination(items = [], { title = '移动到', confirmText = '移动', onCreateDirectory } = {}) {
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
    async function createDestination(path) {
        const response = await window.DiskClient.raw('/directories', window.DiskClient.json('POST', { path }));
        const result = response.operation_id ? await window.DiskClient.wait(response.operation_id) : response;
        onCreateDirectory?.(result.path);
        pathInput.value = telegramDriveDisplayPath(result.path); expandParents(result.path); await reload();
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
                await createDestination([folder.path, input.value.trim()].filter(Boolean).join('/'));
            } catch (error) { alert(telegramDriveErrorText(error)); } finally { save.disabled = false; }
        };
        row.onkeydown = event => { if (event.isComposing) return; if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (event.key === 'Enter') save.click(); else row.remove(); } };
        row.append('📁', input, save, cancel); container.prepend(row); input.focus(); input.select();
    }
    async function reload() {
        const data = await window.DiskClient.raw('/directories');
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
            await createDestination(pathInput.value);
        } catch (error) { alert(telegramDriveErrorText(error)); } finally { create.disabled = false; }
    };
    await reload();
    return openTelegramDriveDialog({ title, body: [hint, root, pathInput, create], confirmText, validate: async () => {
        const safe = pathInput.value.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
        if (blocked(safe)) throw new Error('不能移动到自己或子目录');
        const current = await window.DiskClient.raw('/directories');
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
        if (item.kind === 'directory') {
            const tree = await telegramDriveRequest('/api/telegram/drive/tree?path=' + encodeURIComponent(item.path));
            await telegramDriveRequest(`/api/telegram/drive/directories?path=${encodeURIComponent(item.path)}&recursive=true`, { method: 'DELETE' });
            await window.TelegramDriveCache?.remove(tree.files.map(file => file.id));
        } else {
            await telegramDriveRequest(`/api/telegram/drive/files/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
            await window.TelegramDriveCache?.remove([item.id]);
        }
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
    if (items.some(item => ['blocked', 'deleted'].includes(item.reviewStatus))) throw new Error('管理员屏蔽或删除的文件不可分享');
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
        if (item.reviewStatus === 'deleted') return showTelegramDriveProperties(item);
        return navigateTelegramDrive(item.path);
    }
    if (item.reviewStatus === 'deleted') return showTelegramDriveProperties(item);
    return isDiskPreviewable(item) ? openDiskPreview(item) : showTelegramDriveProperties(item);
}

async function clearTelegramDriveCache(items) {
    const ids = [];
    for (const item of items) {
        if (item.kind === 'directory') {
            const tree = await telegramDriveRequest('/api/telegram/drive/tree?path=' + encodeURIComponent(item.path));
            ids.push(...tree.files.map(file => file.id));
        } else ids.push(item.id);
    }
    await window.TelegramDriveCache?.remove(ids);
    showAppToast(ids.length ? `已清理 ${new Set(ids).size} 个文件缓存` : '目录中没有文件缓存');
    updateDiskCacheLabels();
}

async function cacheTelegramDriveItems(items) {
    const files = new Map();
    for (const item of items) {
        if (item.kind === 'directory') {
            const tree = await telegramDriveRequest('/api/telegram/drive/tree?path=' + encodeURIComponent(item.path));
            for (const file of tree.files) if (!['blocked', 'deleted'].includes(file.reviewStatus)) files.set(file.id, file);
        } else if (!['blocked', 'deleted'].includes(item.reviewStatus)) files.set(item.id, item);
    }
    const list = [...files.values()];
    const cached = await window.TelegramDriveCache?.status(list).catch(() => ({})) || {};
    let requested = 0;
    for (const file of list) {
        if (cached[file.id]) continue;
        requested++;
        try { await window.DiskClient.read(file, { silentLoading: true }); }
        catch (error) { if (error?.name !== 'AbortError' && error?.message !== 'OPERATION_CANCELLED' && error?.message !== 'The user aborted a request.') throw error; }
    }
    showAppToast(requested ? `已缓存 ${requested} 个文件到浏览器` : '所选文件已存在浏览器缓存');
    updateDiskCacheLabels();
}

async function showTelegramDriveItemMenu(item, anchor) {
    if (telegramDriveSelected.size && !telegramDriveSelected.has(telegramDriveItemKey(item))) return;
    closeTelegramDriveItemMenu({ replaceHistory: true });
    telegramDriveMenuItem = item;
    const chosen = telegramDriveActionItems(item);
    let actions = item.kind === 'directory'
        ? [['打开', () => openTelegramDriveItem(item)], ['重命名', () => renameTelegramDriveItem(item)], ['移动', () => moveTelegramDriveItems([item])], ['复制路径', () => copyTelegramDriveItemPath(item)], ['属性', () => showTelegramDriveProperties(item)], ['删除', () => deleteTelegramDriveItems([item]), true]]
        : [['下载并缓存', () => downloadTelegramDriveItem(item)], ['重命名', () => renameTelegramDriveItem(item)], ['移动', () => moveTelegramDriveItems([item])], ['防失联检测', () => checkTelegramDriveItem(item)], ['复制路径', () => copyTelegramDriveItemPath(item)], ['属性', () => showTelegramDriveProperties(item)], ['删除', () => deleteTelegramDriveItems([item]), true]];
    if (item.reviewStatus === 'deleted') actions = [['属性', () => showTelegramDriveProperties(item)], ['删除节点', () => deleteTelegramDriveItems(chosen), true]];
    if (item.kind === 'directory' && item.reviewStatus !== 'deleted') actions.splice(1, 0, ['新建子目录', () => createTelegramDriveFolder(item.path)]);
    else if (item.reviewStatus !== 'deleted' && isDiskPreviewable(item)) actions.unshift(['预览', () => openDiskPreview(item)]);
    if (chosen.length > 1) {
        actions.splice(0, actions.length, ['移动所选 ' + chosen.length + ' 项', () => moveTelegramDriveItems(chosen)], ['删除所选 ' + chosen.length + ' 项', () => deleteTelegramDriveItems(chosen), true]);
    }
    if (item.reviewStatus !== 'deleted') {
        const supportsBoth = chosen.length > 1 || chosen.some(entry => entry.kind === 'directory');
        let cacheActions;
        if (supportsBoth) cacheActions = [['缓存到浏览器', () => cacheTelegramDriveItems(chosen)], ['清理缓存', () => clearTelegramDriveCache(chosen)]];
        else {
            const cached = await window.TelegramDriveCache?.status([item]).catch(() => ({})) || {};
            if (telegramDriveMenuItem !== item) return;
            cacheActions = cached[item.id] ? [['清理缓存', () => clearTelegramDriveCache(chosen)]] : [['缓存到浏览器', () => cacheTelegramDriveItems(chosen)]];
        }
        actions.splice(-1, 0, ...cacheActions);
    }
    if (!chosen.some(entry => ['blocked', 'deleted'].includes(entry.reviewStatus)) && diskExporter) actions.splice(-1, 0, ['转发到隧道', () => exportDiskItems(chosen)]);
    if (!chosen.some(entry => ['blocked', 'deleted'].includes(entry.reviewStatus))) actions.splice(-1, 0, ['分享', () => shareDiskItems(chosen)]);
    renderTelegramDriveContextMenu(item, anchor, actions);
}

function showTelegramDriveBackgroundMenu(anchor) {
    const path = telegramDrivePath;
    const item = { kind: 'directory', path, name: path.split('/').pop() || '根目录' };
    closeTelegramDriveItemMenu({ replaceHistory: true });
    telegramDriveMenuItem = item;
    renderTelegramDriveContextMenu(item, anchor, [
        ['上传文件', () => document.getElementById('telegramDriveFileInput').click()],
        ['新建目录', () => createTelegramDriveFolder(path)],
        ['当前目录属性', () => showTelegramDriveProperties(item)],
        ['清理本级目录缓存', async () => {
            const data = await window.DiskClient.raw('/list?path=' + encodeURIComponent(path));
            await clearTelegramDriveCache(data.files);
        }]
    ]);
}

function renderTelegramDriveContextMenu(item, anchor, actions) {
    const menu = document.getElementById('telegramDriveItemMenu');
    menu.replaceChildren(...actions.map(([label, action, danger]) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; if (danger) button.className = 'danger';
        button.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            const invoke = () => Promise.resolve(action()).catch(error => alert(telegramDriveErrorText(error)));
            if (telegramDriveMenuHistoryOpen && history.state?.telegramDriveMenu) {
                telegramDriveMenuPendingAction = invoke;
                closeTelegramDriveItemMenu();
            } else { closeTelegramDriveItemMenu({ replaceHistory: true }); invoke(); }
        };
        return button;
    }));
    menu.hidden = false;
    const backdrop = document.getElementById('telegramDriveItemMenuBackdrop');
    if (backdrop) backdrop.hidden = false;
    if (!telegramDriveMenuHistoryOpen) {
        history.pushState({ ...(history.state || {}), telegramDriveMenu: true }, '', location.href);
        telegramDriveMenuHistoryOpen = true;
    }
    telegramDriveMenuHistoryClosing = false;
    requestAnimationFrame(() => {
        if (menu.hidden || telegramDriveMenuItem !== item) return;
        const rect = anchor.getBoundingClientRect(), viewport = window.visualViewport;
        const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
        const rightEdge = leftEdge + (viewport?.width || window.innerWidth), bottomEdge = topEdge + (viewport?.height || window.innerHeight);
        const width = menu.offsetWidth || 200, height = menu.offsetHeight;
        const below = rect.bottom + 4, above = rect.top - height - 4;
        menu.style.left = `${Math.max(leftEdge + 8, Math.min(rightEdge - width - 8, rect.right - width))}px`;
        menu.style.top = `${Math.max(topEdge + 8, Math.min(bottomEdge - height - 8, below + height <= bottomEdge - 8 ? below : above))}px`;
    });
}

function renderTelegramDriveItems() {
    const list = document.getElementById('telegramDriveList');
    if (!list || !telegramDriveCurrentData) return;
    list.dataset.view = telegramDriveView;
    const items = getSortedTelegramDriveItems(getTelegramDriveDisplayData());
    updateTelegramDriveBottomSummary();
    if (!items.length) {
        const empty = document.createElement('div'); empty.className = 'telegram-drive-empty'; empty.innerHTML = '<div><div style="font-size:2rem">☁</div><strong>当前目录没有匹配的文件</strong><div>可通过“＋”上传文件或创建文件夹</div></div>';
        list.replaceChildren(empty); return;
    }
    list.replaceChildren(...items.map(item => {
        const key = telegramDriveItemKey(item);
        const row = document.createElement('div'); row.className = `telegram-drive-item${telegramDriveSelected.has(key) ? ' selected' : ''}`; row.tabIndex = 0;
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'telegram-drive-item-check'; checkbox.checked = telegramDriveSelected.has(key); checkbox.setAttribute('aria-label', `选择 ${item.name}`);
        checkbox.onclick = event => event.stopPropagation(); checkbox.onchange = () => { toggleTelegramDriveSelection(item, checkbox.checked); row.classList.toggle('selected', checkbox.checked); };
        const icon = document.createElement('div'); icon.className = 'telegram-drive-item-icon';
        const genericIcon = document.createElement('span'); genericIcon.className = 'telegram-drive-generic-icon'; genericIcon.textContent = telegramDriveMimeIcon(item); icon.append(genericIcon);
        const info = document.createElement('div'); info.className = 'telegram-drive-item-info';
        const name = document.createElement('div'); name.className = 'telegram-drive-item-name'; name.textContent = item.name;
        const meta = document.createElement('div'); meta.className = 'telegram-drive-item-meta'; meta.textContent = getTelegramDriveItemMeta(item); info.append(name, meta);
        if (item.kind !== 'directory' && item.reviewStatus !== 'deleted') {
            const badge = document.createElement('span'); badge.className = 'disk-cache-indicator'; badge.dataset.cacheIndicator = item.id; badge.hidden = true; icon.append(badge);
            badge.addEventListener('pointerdown', event => event.stopPropagation());
            badge.addEventListener('pointerup', event => event.stopPropagation());
            badge.addEventListener('pointercancel', event => event.stopPropagation());
            badge.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); });
            badge.onclick = async event => {
                event.preventDefault(); event.stopPropagation();
                if (!window.DiskClient.isCaching(item.id) || telegramDriveCacheCancelConfirming.has(item.id)) return;
                telegramDriveCacheCancelConfirming.add(item.id);
                try {
                    if (await confirmTelegramDriveAction('取消缓存任务', `确定停止“${item.name}”的缓存拉取吗？`, '取消任务')) window.DiskClient.cancelRead(item.id);
                } finally { telegramDriveCacheCancelConfirming.delete(item.id); }
            };
            const cache = document.createElement('a'); cache.href = '#'; cache.className = 'disk-cache-link'; cache.dataset.cacheId = item.id; cache.textContent = '缓存到浏览器';
            cache.onclick = async event => {
                event.preventDefault(); event.stopPropagation();
                if (cache.classList.contains('cached') || cache.dataset.busy) return;
                cache.dataset.busy = '1'; cache.textContent = '正在缓存…';
                try {
                    await window.DiskClient.read(item);
                    if (!(await window.TelegramDriveCache?.status([item]))?.[item.id]) throw new Error('浏览器未能保存缓存，请检查存储权限与剩余空间');
                } catch (error) {
                    if (error?.name !== 'AbortError' && error?.message !== 'OPERATION_CANCELLED' && error?.message !== 'The user aborted a request.') alert(telegramDriveErrorText(error));
                }
                finally { delete cache.dataset.busy; updateDiskCacheLabels(); }
            };
            meta.append(' · ', cache);
        }
        const more = document.createElement('button'); more.type = 'button'; more.className = 'telegram-drive-icon-btn telegram-drive-item-more'; more.textContent = '⋮'; more.setAttribute('aria-label', `${item.name} 更多操作`); more.onclick = event => { event.stopPropagation(); showTelegramDriveItemMenu(item, more).catch(error => alert(telegramDriveErrorText(error))); };
        let pointerType = '', selectionTimer = 0, selectionBeforeClick = false;
        row.addEventListener('pointerdown', event => { pointerType = event.pointerType; });
        row.onclick = event => {
            if (event.target.closest('input,button,a') || event.detail > 1) return;
            const mouse = pointerType === 'mouse' || (!pointerType && window.matchMedia('(pointer:fine)').matches);
            if (mouse) {
                clearTimeout(selectionTimer);
                selectionBeforeClick = checkbox.checked;
                if (event.shiftKey && telegramDriveSelectionAnchor) {
                    const entries = getSortedTelegramDriveItems(getTelegramDriveDisplayData());
                    const anchorIndex = entries.findIndex(entry => telegramDriveItemKey(entry) === telegramDriveSelectionAnchor);
                    const currentIndex = entries.findIndex(entry => telegramDriveItemKey(entry) === key);
                    if (anchorIndex >= 0 && currentIndex >= 0) {
                        telegramDriveSelected.clear();
                        for (const entry of entries.slice(Math.min(anchorIndex, currentIndex), Math.max(anchorIndex, currentIndex) + 1)) telegramDriveSelected.set(telegramDriveItemKey(entry), entry);
                        renderTelegramDriveItems();
                        updateTelegramDriveSelectionBar();
                        return;
                    }
                }
                checkbox.checked = !checkbox.checked;
                toggleTelegramDriveSelection(item, checkbox.checked, { renderBar: false });
                row.classList.toggle('selected', checkbox.checked);
                telegramDriveSelectionAnchor = key;
                if (!document.getElementById('telegramDriveSelection')?.hidden) updateTelegramDriveSelectionBar();
                selectionTimer = setTimeout(() => { selectionTimer = 0; updateTelegramDriveSelectionBar(); }, 500);
            }
            else if (telegramDriveSelected.size) { checkbox.checked = !checkbox.checked; checkbox.onchange(); }
            else Promise.resolve(openTelegramDriveItem(item)).catch(error => alert(telegramDriveErrorText(error)));
        };
        row.ondblclick = event => {
            if (event.target.closest('input,button,a') || pointerType === 'touch') return;
            if (selectionTimer) {
                clearTimeout(selectionTimer); selectionTimer = 0;
                checkbox.checked = selectionBeforeClick;
                toggleTelegramDriveSelection(item, checkbox.checked, { renderBar: false });
                row.classList.toggle('selected', checkbox.checked);
                updateTelegramDriveSelectionBar();
            }
            event.preventDefault(); Promise.resolve(openTelegramDriveItem(item)).catch(error => alert(telegramDriveErrorText(error)));
        };
        row.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); Promise.resolve(openTelegramDriveItem(item)).catch(error => alert(telegramDriveErrorText(error))); } };
        row.append(checkbox, icon, info, more);
        // The thumbnail worker discards detached icons. Queue after this render
        // has inserted the rows into the document instead of racing replaceChildren().
        queueMicrotask(() => scheduleTelegramDriveThumbnail(item, icon));
        installContextGesture(
            row,
            event => showTelegramDriveItemMenu(item, { getBoundingClientRect: () => ({ left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY }) }).catch(error => alert(telegramDriveErrorText(error))),
            event => {
                if (telegramDriveSelected.size && !telegramDriveSelected.has(key)) return;
                beginTouchDiskDrag(telegramDriveActionItems(item), row, event);
            }
        );
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
    const destination = telegramDrivePath;
    const result = await window.DiskClient.upload(files, destination);
    showAppToast('已上传 ' + files.length + ' 个文件' + (result.warnings?.length ? '；部分 Telegram 定位备注未能更新，文件索引已保存' : ''));
    // Only refresh the directory where the upload was initiated. A render
    // generation prevents an older in-flight list request from overwriting it.
    if (telegramDrivePath === destination) await refreshTelegramDriveContents();
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
    await window.DiskClient.raw('/logout', { method: 'POST' });
    window.DiskClient.stop();
    closeDiskPreview();
    telegramDrivePath = '';
    telegramDriveCurrentData = null;
    clearTelegramDriveSearch();
    clearTelegramDriveSelection();
    await renderTelegramDrive({ silentIdentity: true });
    showAppToast('已退出网盘账号');
}

async function renderTelegramDrive({ silentIdentity = false } = {}) {
    const generation = ++telegramDriveRenderGeneration;
    const requestedPath = telegramDrivePath;
    closeTelegramDriveItemMenu({ replaceHistory: true });
    const list = document.getElementById('telegramDriveList');
    const workspace = document.getElementById('telegramDriveWorkspace');
    const auth = document.getElementById('telegramDriveAuth');
    const logout = document.getElementById('telegramDriveLogoutBtn');
    const sort = document.getElementById('telegramDriveSort'); if (sort) sort.value = telegramDriveSort;
    const direction = document.getElementById('telegramDriveSortDirectionBtn'); if (direction) { direction.textContent = telegramDriveSortAscending ? '↑' : '↓'; direction.setAttribute('aria-label', telegramDriveSortAscending ? '当前升序' : '当前降序'); }
    const view = document.getElementById('telegramDriveViewBtn'); if (view) { view.textContent = telegramDriveView === 'list' ? '▦' : '☷'; view.setAttribute('aria-label', telegramDriveView === 'list' ? '切换为网格视图' : '切换为列表视图'); }
    const backgroundTasksHidden = window.DiskClient.hasHiddenLoading?.();
    const status = silentIdentity || backgroundTasksHidden ? await getTelegramDriveIdentity() : await window.DiskClient.withActivity('正在加载网盘', getTelegramDriveIdentity);
    if (generation !== telegramDriveRenderGeneration) return;
    logout.hidden = !status.identity;
    if (!status.identity) {
        workspace.hidden = true;
        list.replaceChildren();
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
    const account = document.createElement('a'); account.href = '#';
    account.textContent = `当前账号：${status.identity.name || status.identity.username || status.identity.id}（ID：${status.identity.id}）`;
    account.onclick = event => {
        event.preventDefault();
        const body = document.createElement('div');
        const identity = document.createElement('p'); identity.textContent = account.textContent; body.append(identity);
        if (status.oidcMode !== 'mock') appendPasskeyControls(body, status.identity);
        else body.append('本地 Mock 账号不使用 Passkey。');
        openTelegramDriveDialog({ title: '网盘账号设置', body, confirmText: '关闭', cancelText: '' });
    };
    auth.replaceChildren(account);
    if (notices.length) auth.append('；' + notices.join('；'));
    workspace.hidden = false;
    window.DiskClient.start();
    const listUrl = `/api/telegram/drive/list?path=${encodeURIComponent(requestedPath)}`;
    const data = backgroundTasksHidden ? await window.DiskClient.raw(listUrl) : await telegramDriveRequest(listUrl);
    if (generation !== telegramDriveRenderGeneration) return;
    telegramDriveCurrentData = data;
    telegramDriveContentStale = false;
    telegramDriveSearchData = null;
    telegramDrivePath = data.path || '';
    renderTelegramDriveBreadcrumbs(telegramDriveCurrentData);
    renderTelegramDriveItems();
    updateTelegramDriveSelectionBar();
}

async function refreshTelegramDriveContents() {
    if (!telegramDriveCurrentData || document.getElementById('telegramDriveOverlay').hidden) return;
    const generation = ++telegramDriveRenderGeneration, requestedPath = telegramDrivePath;
    const data = await window.DiskClient.raw('/list?path=' + encodeURIComponent(requestedPath));
    if (generation !== telegramDriveRenderGeneration || requestedPath !== telegramDrivePath) return;
    telegramDriveCurrentData = data;
    renderTelegramDriveItems();
    scheduleTelegramDriveSearch();
}

async function navigateTelegramDrive(path, { fromHistory = false, deferRender = false, fromUpload = false } = {}) {
    if (!fromUpload) telegramDriveNavigationVersion++;
    telegramDrivePath = String(path || '');
    if (diskWindowState.retained) saveDiskWindow(true);
    clearTelegramDriveSearch();
    clearTelegramDriveSelection();
    if (!fromHistory && telegramDriveHistorySession) history.pushState({ ...(history.state || {}), telegramDriveOpen: true, telegramDrivePath, telegramDriveHistorySession }, '', location.href);
    if (deferRender) { telegramDriveCurrentData = null; telegramDriveContentStale = true; }
    else await renderTelegramDrive();
}

async function revealTelegramDriveUploadedDirectory(path, navigationVersion) {
    if (navigationVersion !== telegramDriveNavigationVersion) return false;
    await navigateTelegramDrive(path, { deferRender: document.getElementById('telegramDriveOverlay').hidden, fromUpload: true });
    return true;
}

async function openTelegramDrive() {
    const overlay = document.getElementById('telegramDriveOverlay');
    const reuse = overlay.hidden && Boolean(diskWindowState.retained && telegramDriveCurrentData && !telegramDriveContentStale);
    if (overlay.hidden) { const tasks = document.getElementById('diskTasks'); if (tasks) tasks.open = false; }
    const starting = !telegramDriveHistorySession;
    if (starting) telegramDriveHistorySession = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const state = { ...(history.state || {}), telegramDriveOpen: true, telegramDrivePath, telegramDriveHistorySession };
    if (starting) history.pushState(state, '', location.href); else history.replaceState(state, '', location.href);
    overlay.hidden = false; overlay.classList.add('active');
    document.body.classList.add('telegram-drive-open');
    if (reuse) { renderTelegramDriveBreadcrumbs(telegramDriveCurrentData); renderTelegramDriveItems(); updateDiskCacheLabels(); }
    else await renderTelegramDrive();
}
function closeTelegramDrive({ forget = false } = {}) {
    if (!$disk('diskPreview')?.hidden) closeDiskPreview({ replaceHistory: true });
    closeTelegramDriveDialog(null, { replaceHistory: true }); closeTelegramDriveItemMenu({ replaceHistory: true });
    const overlay = document.getElementById('telegramDriveOverlay'); overlay.classList.remove('active'); overlay.hidden = true;
    document.body.classList.remove('telegram-drive-open');
    if (forget) { saveDiskWindow(false); telegramDriveCurrentData = null; telegramDriveSearchData = null; telegramDriveContentStale = true; }
    const tasks = document.getElementById('diskTasks'); if (tasks) tasks.open = false;
    telegramDriveHistorySession = '';
    const next = { ...(history.state || {}) }; delete next.telegramDriveOpen; delete next.telegramDrivePath; delete next.telegramDriveHistorySession;
    history.replaceState(next, '', location.href);
}
function minimizeTelegramDrive() {
    if (!$disk('diskPreview')?.hidden) closeDiskPreview({ replaceHistory: true });
    closeTelegramDriveDialog(null, { replaceHistory: true }); closeTelegramDriveItemMenu({ replaceHistory: true });
    const overlay = document.getElementById('telegramDriveOverlay'); overlay.classList.remove('active'); overlay.hidden = true;
    document.body.classList.remove('telegram-drive-open');
    saveDiskWindow(true);
    telegramDriveHistorySession = '';
    const next = { ...(history.state || {}) }; delete next.telegramDriveOpen; delete next.telegramDrivePath; delete next.telegramDriveHistorySession;
    history.replaceState(next, '', location.href);
}
function prepareTelegramDrivePicker() {
    const overlay = document.getElementById('telegramDriveOverlay');
    overlay.classList.add('telegram-drive-picker-mode');
    if (!overlay.hidden) return;
    if (!telegramDriveHistorySession) telegramDriveHistorySession = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    history.pushState({ ...(history.state || {}), telegramDriveOpen: true, telegramDrivePath, telegramDriveHistorySession }, '', location.href);
    overlay.hidden = false; overlay.classList.add('active');
    document.body.classList.add('telegram-drive-open');
}
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
let previewItems = [], previewIndex = 0, previewGeneration = 0, previewURL = '', previewAbort, diskPreviewHistoryOpen = false, diskPreviewHistoryClosing = false, diskPreviewBaseState = null;
const diskMediaProgressKey = 'telegram-drive-media-progress-v1';
let diskMediaProgress = {};
try { diskMediaProgress = JSON.parse(localStorage.getItem(diskMediaProgressKey) || '{}') || {}; } catch (_) {}
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
            const idleLabel = button.textContent;
            button.disabled = true;
            button.textContent = kind === 'login' ? '正在调起系统 Passkey…' : '正在准备 Passkey…';
            try {
                if (!window.isSecureContext) throw new Error('Passkey 需要 HTTPS 安全连接');
                if (!window.PublicKeyCredential || !navigator.credentials) throw new Error('当前浏览器不支持 Passkey，请使用支持通行密钥的浏览器');
                if (!window.SimpleWebAuthnBrowser) throw new Error('Passkey 脚本未加载，请管理员检查 /client/simplewebauthn.js 和发布依赖；这不是账号名或 HTTPS 的问题');
                const flow = await window.DiskClient.raw('/passkeys/' + kind + '/options', window.DiskClient.json('POST', { username: input.value }));
                const response = kind === 'login'
                    ? await window.SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: flow.options })
                    : await window.SimpleWebAuthnBrowser.startRegistration({ optionsJSON: flow.options });
                await window.DiskClient.raw('/passkeys/verify', window.DiskClient.json('POST', { flow_id: flow.flow_id, response }));
                if (user) closeTelegramDriveDialog(null);
                await renderTelegramDrive();
            } catch (error) { alert(telegramDriveErrorText(error)); } finally { button.disabled = false; button.textContent = idleLabel; }
        };
        group.append(button);
    }
    target.append(group);
}
function installContextGesture(element, open, beginTouchDrag = null, options = {}) {
    const { twoFingerTap = Boolean(beginTouchDrag), longPress = true, accept = () => true } = options;
    let timer, start, primaryTouchEvent = null, suppressUntil = 0, twoFinger = null, touchContextSuppressedUntil = 0;
    const touches = new Map();
    const cancel = () => { clearTimeout(timer); timer = null; start = null; };
    element.addEventListener('contextmenu', event => {
        if (!accept(event)) return;
        event.preventDefault(); event.stopPropagation();
        const pendingTouchLongPress = Boolean(start && primaryTouchEvent && !twoFinger);
        cancel();
        if (!longPress && (event.pointerType === 'touch' || pendingTouchLongPress || touches.size || Date.now() < touchContextSuppressedUntil)) return;
        if (beginTouchDrag && (event.pointerType === 'touch' || pendingTouchLongPress)) {
            if (pendingTouchLongPress && Date.now() >= suppressUntil) { suppressUntil = Date.now() + 1400; beginTouchDrag(primaryTouchEvent); }
            return;
        }
        if (beginTouchDrag && Date.now() < suppressUntil) return;
        suppressUntil = Date.now() + 700; open(event);
    });
    element.addEventListener('pointerdown', event => {
        if (!accept(event)) return;
        if (event.pointerType !== 'touch') { cancel(); return; }
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
        if (twoFingerTap && touches.size > 2) { cancel(); twoFinger = null; return; }
        if (twoFingerTap && touches.size === 2) {
            cancel(); suppressUntil = Date.now() + 1200;
            const points = [...touches.values()];
            twoFinger = { startedAt: Date.now(), moved: false, x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
            event.preventDefault(); event.stopPropagation(); return;
        }
        if (!event.isPrimary || touches.size !== 1) return;
        cancel(); primaryTouchEvent = event; start = { x: event.clientX, y: event.clientY };
        if (longPress) timer = setTimeout(() => {
            timer = null; start = null; suppressUntil = Date.now() + 1400;
            if (beginTouchDrag) beginTouchDrag(event); else open(event);
        }, 550);
    });
    element.addEventListener('pointermove', event => {
        const point = touches.get(event.pointerId);
        if (point) {
            point.x = event.clientX; point.y = event.clientY;
            if (twoFinger && Math.hypot(point.x - point.startX, point.y - point.startY) > 12) twoFinger.moved = true;
        }
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancel();
    });
    const finishTouch = event => {
        if (!longPress && touches.has(event.pointerId)) touchContextSuppressedUntil = suppressUntil = Date.now() + 700;
        touches.delete(event.pointerId); cancel(); if (!touches.size) primaryTouchEvent = null;
        if (!twoFinger || touches.size) return;
        const gesture = twoFinger; twoFinger = null;
        if (!gesture.moved && Date.now() - gesture.startedAt < 650) {
            suppressUntil = Date.now() + 1000;
            open({ clientX: gesture.x, clientY: gesture.y, preventDefault() {}, stopPropagation() {} });
        }
    };
    element.addEventListener('pointerup', finishTouch);
    element.addEventListener('pointercancel', event => { touches.delete(event.pointerId); twoFinger = null; primaryTouchEvent = null; cancel(); });
    element.addEventListener('selectstart', event => { if (accept(event) && (timer || Date.now() < suppressUntil)) event.preventDefault(); });
    element.addEventListener('click', event => { if (accept(event) && Date.now() < suppressUntil) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
}
function installDiskDrop(element, path) {
    element.dataset.diskDropPath = String(path || '');
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
function beginTouchDiskDrag(items, sourceRow, event) {
    if (!items.length) return;
    const pointerId = event.pointerId;
    const ghost = document.createElement('div'); ghost.className = 'telegram-drive-touch-drag';
    ghost.textContent = items.length === 1 ? items[0].name : `正在移动 ${items.length} 项`;
    document.body.append(ghost); sourceRow.classList.add('disk-drag-source');
    let target = null;
    const invalidTarget = path => items.some(item => item.kind === 'directory' && (path === item.path || path.startsWith(item.path + '/')));
    const position = pointerEvent => {
        pointerEvent.preventDefault();
        ghost.style.transform = `translate3d(${pointerEvent.clientX + 14}px,${pointerEvent.clientY + 14}px,0)`;
        const candidate = document.elementsFromPoint(pointerEvent.clientX, pointerEvent.clientY)
            .find(node => node instanceof HTMLElement && Object.prototype.hasOwnProperty.call(node.dataset, 'diskDropPath'));
        const next = candidate && !invalidTarget(candidate.dataset.diskDropPath || '') ? candidate : null;
        if (next !== target) { target?.classList.remove('disk-drop-target'); target = next; target?.classList.add('disk-drop-target'); }
    };
    const cleanup = () => {
        window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', finish, true); window.removeEventListener('pointercancel', cancelDrag, true);
        target?.classList.remove('disk-drop-target'); sourceRow.classList.remove('disk-drag-source'); ghost.remove();
    };
    const move = pointerEvent => { if (pointerEvent.pointerId === pointerId) position(pointerEvent); };
    const finish = pointerEvent => {
        if (pointerEvent.pointerId !== pointerId) return;
        pointerEvent.preventDefault(); const destination = target?.dataset.diskDropPath; cleanup();
        if (destination === undefined) return;
        const unchanged = items.every(item => (item.kind === 'directory' ? item.path.split('/').slice(0, -1).join('/') : item.folderPath || '') === destination);
        if (!unchanged) moveTelegramDriveItems(items, destination).catch(error => alert(telegramDriveErrorText(error)));
    };
    const cancelDrag = pointerEvent => { if (pointerEvent.pointerId === pointerId) cleanup(); };
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', finish, { capture: true, passive: false });
    window.addEventListener('pointercancel', cancelDrag, true);
    position(event);
}
async function exportDiskItems(items) {
    const files = new Map();
    for (const item of items) {
        if (item.kind !== 'directory') { if (!files.has(item.id)) files.set(item.id, item); continue; }
        const tree = await telegramDriveRequest('/api/telegram/drive/tree?path=' + encodeURIComponent(item.path));
        for (const file of tree.files) files.set(file.id, { ...file, relativePath: [file.folderPath.slice(item.path.length), file.name].filter(Boolean).join('/').replace(/^\/+/, '') });
    }
    if (!files.size) throw new Error('所选项目没有文件');
    if ([...files.values()].some(file => ['blocked', 'deleted'].includes(file.reviewStatus))) throw new Error('管理员屏蔽或删除的文件不可转发');
    await diskExporter([...files.values()]);
}
const diskThumbnailQueue = [];
let diskThumbnailWorkers = 0;
function telegramDriveMimeIcon(item) {
    if (item.kind === 'directory') return '📁';
    const type = getDiskPreviewType(item);
    if (type.startsWith('image/')) return '🖼️';
    if (type.startsWith('video/')) return '🎬';
    if (type.startsWith('audio/')) return '🎵';
    if (type === 'application/pdf') return '📕';
    if (/^(text\/|application\/(?:json|xml))/.test(type)) return '📄';
    if (/(?:zip|rar|7z|tar|gzip|compressed|archive)/.test(type)) return '📦';
    if (/(?:word|document)/.test(type)) return '📝';
    if (/(?:sheet|excel|spreadsheet)/.test(type)) return '📊';
    return '📎';
}
function canvasThumbnail(element) {
    const sourceWidth = Number(element.videoWidth || element.naturalWidth || element.width);
    const sourceHeight = Number(element.videoHeight || element.naturalHeight || element.height);
    if (!sourceWidth || !sourceHeight) return Promise.resolve(null);
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 112;
    const context = canvas.getContext('2d');
    if (!context) return Promise.resolve(null);
    context.fillStyle = '#111923'; context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const width = sourceWidth * scale, height = sourceHeight * scale;
    context.drawImage(element, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .76));
}
function waitForMediaEvent(element, names, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const done = event => { cleanup(); event.type === 'error' ? reject(element.error || new Error('THUMBNAIL_MEDIA_ERROR')) : resolve(event); };
        const cleanup = () => { clearTimeout(timer); for (const name of [...names, 'error']) element.removeEventListener(name, done); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('THUMBNAIL_TIMEOUT')); }, timeoutMs);
        for (const name of [...names, 'error']) element.addEventListener(name, done, { once: true });
    });
}
async function imageFromSource(source, alt = '') {
    const image = new Image(); image.alt = alt; image.src = source;
    if (!image.complete || !image.naturalWidth) await waitForMediaEvent(image, ['load']);
    return image;
}
async function generateTelegramDriveThumbnail(item) {
    const type = getDiskPreviewType(item);
    if (!/^(image|audio|video)\//.test(type)) return null;
    if (item.thumbnailAvailable) {
        const source = `/api/telegram/drive/files/${encodeURIComponent(item.id)}/thumbnail?v=${encodeURIComponent(item.updatedAt || '')}`;
        return canvasThumbnail(await imageFromSource(source, item.name));
    }
    const cached = await window.TelegramDriveCache?.get(item.id).catch(() => null);
    const completeBlob = cached?.blob?.size === Number(item.size) ? cached.blob : null;
    let sourceUrl = '', release = false;
    try {
        if (type.startsWith('audio/')) {
            if (!loadAudioCover) return null;
            const source = completeBlob || await window.DiskClient.readRange(item, 0, Math.min(Number(item.size) - 1, 2 * 1024 * 1024 - 1), { purpose: 'audio-cover' });
            const coverUrl = await loadAudioCover(source, item);
            if (!coverUrl) return null;
            return canvasThumbnail(await imageFromSource(coverUrl, item.name));
        }
        if (completeBlob) { sourceUrl = URL.createObjectURL(completeBlob); release = true; }
        else sourceUrl = window.DiskClient.streamUrl(item, { purpose: 'thumbnail', fresh: true });
        if (type.startsWith('image/')) return canvasThumbnail(await imageFromSource(sourceUrl, item.name));
        const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.preload = 'metadata'; video.src = sourceUrl;
        await waitForMediaEvent(video, ['loadedmetadata']);
        if (Number.isFinite(video.duration) && video.duration > .2) {
            if (video.readyState < 2) await waitForMediaEvent(video, ['loadeddata']);
            const seeked = waitForMediaEvent(video, ['seeked']);
            video.currentTime = Math.min(Math.max(.1, video.duration * .08), 2);
            await seeked;
            if (video.readyState < 2) await waitForMediaEvent(video, ['loadeddata']);
        } else if (video.readyState < 2) await waitForMediaEvent(video, ['loadeddata']);
        return canvasThumbnail(video);
    } finally { if (release && sourceUrl) URL.revokeObjectURL(sourceUrl); }
}
function applyTelegramDriveThumbnail(icon, blob, item) {
    if (!icon?.isConnected || icon.dataset.thumbnailId !== item.id || !(blob instanceof Blob)) return;
    const url = URL.createObjectURL(blob), image = document.createElement('img');
    image.className = 'telegram-drive-thumbnail'; image.alt = ''; image.src = url;
    image.onload = image.onerror = () => URL.revokeObjectURL(url);
    icon.querySelector('.telegram-drive-generic-icon')?.replaceWith(image);
    icon.classList.add('has-thumbnail');
}
function runDiskThumbnailQueue() {
    while (diskThumbnailWorkers < 2 && diskThumbnailQueue.length) {
        const { item, icon } = diskThumbnailQueue.shift();
        if (!icon?.isConnected) continue;
        diskThumbnailWorkers++;
        Promise.resolve(window.TelegramDriveCache?.getThumbnail(item.id)).then(async cached => {
            if (cached) return applyTelegramDriveThumbnail(icon, cached, item);
            const blob = await generateTelegramDriveThumbnail(item);
            if (!blob) return;
            await window.TelegramDriveCache?.putThumbnail(item.id, blob).catch(() => {});
            applyTelegramDriveThumbnail(icon, blob, item);
        }).catch(() => {}).finally(() => { diskThumbnailWorkers--; runDiskThumbnailQueue(); });
    }
}
function scheduleTelegramDriveThumbnail(item, icon) {
    if (item.kind === 'directory' || !/^(image|audio|video)\//.test(getDiskPreviewType(item)) || item.reviewStatus === 'deleted') return;
    icon.dataset.thumbnailId = item.id;
    diskThumbnailQueue.push({ item, icon }); runDiskThumbnailQueue();
}
function getDiskPreviewType(file) {
    if (file.type && file.type !== 'application/octet-stream') return file.type;
    const ext = String(file.name || '').toLowerCase().split('.').pop();
    return ({ mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime', m4v:'video/mp4', mp3:'audio/mpeg', m4a:'audio/mp4', aac:'audio/aac', ogg:'audio/ogg', opus:'audio/ogg', wav:'audio/wav', flac:'audio/flac', jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', avif:'image/avif', svg:'image/svg+xml', pdf:'application/pdf', txt:'text/plain' })[ext] || file.type || 'application/octet-stream';
}
function isDiskPreviewable(file) {
    const type = getDiskPreviewType(file);
    return file.kind !== 'directory' && (/^(image|audio|video|text)\//.test(type) || type === 'application/pdf');
}
function saveDiskMediaProgress(item, media, ended = false) {
    if (!item?.id || !media) return;
    const duration = Number(media.duration), currentTime = ended ? 0 : Number(media.currentTime);
    if (!Number.isFinite(currentTime) || currentTime < 0) return;
    if (ended || (Number.isFinite(duration) && duration > 0 && currentTime >= duration - 1)) delete diskMediaProgress[item.id];
    else diskMediaProgress[item.id] = { time: currentTime, updatedAt: Date.now() };
    const entries = Object.entries(diskMediaProgress).sort((left, right) => Number(right[1]?.updatedAt) - Number(left[1]?.updatedAt)).slice(0, 300);
    diskMediaProgress = Object.fromEntries(entries);
    try { localStorage.setItem(diskMediaProgressKey, JSON.stringify(diskMediaProgress)); } catch (_) {}
}
function disposeActiveDiskMedia() {
    const body = $disk('diskPreviewBody');
    body?.querySelector('.disk-preview-image-frame')?._disposeDiskImage?.();
    const media = body?.querySelector('audio,video');
    if (!media) return;
    if (typeof media._disposeDiskMedia === 'function') return media._disposeDiskMedia();
    media._saveDiskProgress?.();
    try { media.pause(); } catch (_) {}
    media.removeAttribute('src');
    try { media.load(); } catch (_) {}
}
function closeDiskPreview({ fromHistory = false, replaceHistory = false } = {}) {
    if (diskPreviewHistoryClosing && !fromHistory && !replaceHistory) return;
    disposeActiveDiskMedia();
    previewGeneration++; previewAbort?.abort();
    const overlay = $disk('diskPreview'); if (!overlay) return;
    overlay.hidden = true; $disk('diskPreviewBody').replaceChildren();
    if (previewURL) URL.revokeObjectURL(previewURL); previewURL = '';
    const shouldGoBack = diskPreviewHistoryOpen && !fromHistory && !replaceHistory && history.state?.telegramDrivePreview && !diskPreviewHistoryClosing;
    if (replaceHistory && history.state?.telegramDrivePreview) {
        const next = { ...(history.state || {}) }; delete next.telegramDrivePreview;
        history.replaceState(next, '', location.href);
    }
    if (fromHistory) { diskPreviewHistoryOpen = false; diskPreviewHistoryClosing = false; diskPreviewBaseState = null; }
    else if (shouldGoBack) { diskPreviewHistoryClosing = true; history.back(); }
    else if (!history.state?.telegramDrivePreview || replaceHistory) { diskPreviewHistoryOpen = false; diskPreviewHistoryClosing = false; diskPreviewBaseState = null; }
}
async function openDiskPreview(item) {
    previewItems = getSortedTelegramDriveItems(getTelegramDriveDisplayData()).filter(isDiskPreviewable);
    previewIndex = Math.max(0, previewItems.findIndex(file => file.id === item.id));
    $disk('diskPreview').hidden = false;
    if (!diskPreviewHistoryOpen) {
        // Anchor the entry below the preview to the directory that is actually
        // visible now.  A retained drive window can otherwise inherit a stale
        // directory entry from before it was closed/minimized, and closing the
        // preview then closes the drive or jumps back to that old directory.
        const base = { ...(history.state || {}), telegramDriveOpen: true, telegramDrivePath, telegramDriveHistorySession };
        delete base.telegramDrivePreview;
        diskPreviewBaseState = base;
        history.replaceState(base, '', location.href);
        history.pushState({ ...base, telegramDrivePreview: true }, '', location.href);
    }
    diskPreviewHistoryOpen = true; diskPreviewHistoryClosing = false;
    return renderDiskPreview();
}
function formatDiskMediaTime(value) {
    if (!Number.isFinite(value) || value < 0) return '0:00';
    const seconds = Math.floor(value), minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
const diskMediaIcons = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.4v13.2c0 .8.9 1.3 1.6.9l9.5-6.6a1.1 1.1 0 0 0 0-1.8L9.6 4.5A1 1 0 0 0 8 5.4Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="4.5" width="4" height="15" rx="1.2"/><rect x="13.5" y="4.5" width="4" height="15" rx="1.2"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.3 8.2V3.8L2.2 6.9l3.1 3.2V8.2A7.5 7.5 0 1 1 4.6 16l2-1.1A5.2 5.2 0 1 0 7 9.4Z"/><text x="9.2" y="15.1">10</text></svg>',
    forward: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.7 8.2V3.8l3.1 3.1-3.1 3.2V8.2a7.5 7.5 0 1 0 .7 7.8l-2-1.1a5.2 5.2 0 1 1-.4-5.5Z"/><text x="7" y="15.1">10</text></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 3h2v10.1l3.2-3.2 1.4 1.4-5.6 5.6-5.6-5.6 1.4-1.4 3.2 3.2V3Z"/><path d="M4 18h16v3H4z"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    volume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Zm12.2-.9a5.5 5.5 0 0 1 0 7.8l1.4 1.4a7.5 7.5 0 0 0 0-10.6l-1.4 1.4Z"/></svg>'
};
function diskMediaButton(icon, label, className = '') {
    const button = document.createElement('button'); button.type = 'button'; button.className = `disk-media-icon-button ${className}`.trim();
    button.innerHTML = diskMediaIcons[icon]; button.title = label; button.setAttribute('aria-label', label); return button;
}
async function loadDiskAudioPlayerCover(item, cover, cachedBlob) {
    const showImage = async source => {
        const image = await imageFromSource(source, `${item.name} 封面`);
        if (cover.isConnected) cover.replaceChildren(image);
    };
    // The separately stored image is available without reading any song parts.
    if (item.thumbnailAvailable) {
        try { await showImage(`/api/telegram/drive/files/${encodeURIComponent(item.id)}/thumbnail?v=${encodeURIComponent(item.updatedAt || '')}`); return; }
        catch (_) { /* Legacy/missing thumbnail: try the existing local sources. */ }
    }
    const metadataCover = item.metadata?.coverUrl || item.metadata?.cover || item.metadata?.thumbnailUrl;
    if (metadataCover) { try { await showImage(metadataCover); return; } catch (_) {} }
    let thumbnail = await window.TelegramDriveCache?.getThumbnail(item.id).catch(() => null);
    if (!thumbnail && cachedBlob && loadAudioCover) {
        const source = await loadAudioCover(cachedBlob, item);
        if (source) { await showImage(source); return; }
    }
    if (!thumbnail) {
        thumbnail = await generateTelegramDriveThumbnail(item);
        if (thumbnail) await window.TelegramDriveCache?.putThumbnail(item.id, thumbnail).catch(() => {});
    }
    if (!thumbnail || !cover.isConnected) return;
    const source = URL.createObjectURL(thumbnail);
    try { await showImage(source); } finally { URL.revokeObjectURL(source); }
}
function createDiskMediaPlayer(item, source, type, cachedBlob = null) {
    const video = type.startsWith('video/');
    const wrapper = document.createElement('section'); wrapper.className = `disk-media-player ${video ? 'is-video' : 'is-audio'}`;
    const stage = document.createElement('div'); stage.className = 'disk-media-stage';
    const media = document.createElement(video ? 'video' : 'audio'); media.src = source; media.preload = 'metadata'; media.playsInline = true; media.title = item.name;
    let audioCover = null;
    if (video) stage.append(media);
    else {
        const cover = document.createElement('div'); cover.className = 'disk-audio-cover'; cover.textContent = '♫'; audioCover = cover;
        loadDiskAudioPlayerCover(item, cover, cachedBlob).catch(() => {});
        stage.append(cover, media);
    }
    const center = diskMediaButton('play', '播放', 'disk-media-center-play'); stage.append(center);
    const bufferStatus = document.createElement('span'); bufferStatus.className = 'disk-media-buffer-status'; bufferStatus.hidden = true; stage.append(bufferStatus);
    const controls = document.createElement('div'); controls.className = 'disk-media-controls';
    const back = diskMediaButton('back', '后退 10 秒');
    const play = diskMediaButton('play', '播放');
    const forward = diskMediaButton('forward', '快进 10 秒');
    const seek = document.createElement('input'); seek.type = 'range'; seek.min = '0'; seek.max = '1000'; seek.value = '0'; seek.className = 'disk-media-seek'; seek.setAttribute('aria-label', '播放进度');
    const seekLoader = document.createElement('span'); seekLoader.className = 'disk-media-seek-loader'; seekLoader.setAttribute('aria-hidden', 'true');
    const seekTrack = document.createElement('div'); seekTrack.className = 'disk-media-seek-track'; seekTrack.append(seek, seekLoader);
    const time = document.createElement('span'); time.className = 'disk-media-time'; time.textContent = '0:00 / 0:00';
    const volume = document.createElement('input'); volume.type = 'range'; volume.min = '0'; volume.max = '1'; volume.step = '.05'; volume.value = '1'; volume.className = 'disk-media-volume'; volume.setAttribute('aria-label', '音量');
    const volumeWrap = document.createElement('label'); volumeWrap.className = 'disk-media-volume-wrap'; volumeWrap.title = '音量'; volumeWrap.innerHTML = diskMediaIcons.volume; volumeWrap.append(volume);
    const download = diskMediaButton('download', '下载');
    const share = diskMediaButton('share', '分享');
    const seekRow = document.createElement('div'); seekRow.className = 'disk-media-seek-row'; seekRow.append(seekTrack, time);
    const actionRow = document.createElement('div'); actionRow.className = 'disk-media-action-row'; actionRow.append(back, play, forward, volumeWrap, download, share);
    controls.append(seekRow, actionRow);
    wrapper.append(stage, controls);
    let centerTimer = 0, requestedTime = null, lastProgressSavedAt = 0;
    let disposed = false;
    const syncSeekThumb = () => {
        const ratio = Math.max(0, Math.min(1, Number(seek.value) / 1000));
        seekTrack.style.setProperty('--seek-percent', `${ratio * 100}%`);
        // A native range thumb moves only between its two radius insets.
        seekTrack.style.setProperty('--seek-thumb-position', `calc(${ratio * 100}% + ${7 - ratio * 14}px)`);
    };
    const showCenter = () => {
        wrapper.classList.remove('disk-media-idle'); clearTimeout(centerTimer);
        if (!media.paused) centerTimer = setTimeout(() => wrapper.classList.add('disk-media-idle'), 2000);
    };
    const syncPlay = () => {
        const paused = media.paused;
        play.innerHTML = diskMediaIcons[paused ? 'play' : 'pause']; center.innerHTML = diskMediaIcons[paused ? 'play' : 'pause'];
        play.title = paused ? '播放' : '暂停'; play.setAttribute('aria-label', play.title); center.setAttribute('aria-label', play.title);
        center.classList.toggle('playing', !paused);
        if (paused) { clearTimeout(centerTimer); wrapper.classList.remove('disk-media-idle'); }
        else showCenter();
    };
    const toggle = () => media.paused ? media.play().catch(() => {}) : media.pause();
    center.onclick = event => { event.stopPropagation(); toggle(); }; play.onclick = toggle;
    const optimisticSeek = value => {
        if (!Number.isFinite(media.duration) || media.duration <= 0) return;
        requestedTime = Math.max(0, Math.min(media.duration, value));
        seek.value = String(Math.round(requestedTime / media.duration * 1000));
        syncSeekThumb();
        time.textContent = `${formatDiskMediaTime(requestedTime)} / ${formatDiskMediaTime(media.duration)}`;
        wrapper.classList.add('is-buffering'); bufferStatus.hidden = false; bufferStatus.textContent = '正在加载当前片段…';
        media.currentTime = requestedTime; showCenter();
    };
    back.onclick = () => optimisticSeek((requestedTime ?? media.currentTime) - 10);
    forward.onclick = () => optimisticSeek((requestedTime ?? media.currentTime) + 10);
    seek.oninput = () => optimisticSeek(Number(seek.value) / 1000 * media.duration);
    volume.oninput = () => { media.volume = Number(volume.value); };
    let restoredProgress = false;
    media.addEventListener('loadedmetadata', () => {
        if (restoredProgress) return;
        restoredProgress = true;
        const saved = Number(diskMediaProgress[item.id]?.time);
        if (Number.isFinite(saved) && saved > .25 && saved < media.duration - .5) optimisticSeek(saved);
    });
    media._saveDiskProgress = () => saveDiskMediaProgress(item, media);
    media._disposeDiskMedia = () => {
        if (disposed) return;
        disposed = true;
        media._saveDiskProgress();
        clearTimeout(centerTimer);
        try { media.pause(); } catch (_) {}
        media.removeAttribute('src');
        try { media.load(); } catch (_) {}
    };
    media.addEventListener('play', syncPlay);
    media.addEventListener('pause', () => { syncPlay(); saveDiskMediaProgress(item, media); });
    media.addEventListener('ended', () => {
        syncPlay(); saveDiskMediaProgress(item, media, true);
        window.TelegramDriveCache?.status([item]).then(status => {
            if (!status?.[item.id]) return window.DiskClient.read(item, { silentLoading: true }).then(() => updateDiskCacheLabels());
        }).catch(() => {});
    });
    const updateBuffer = () => {
        if (!wrapper.classList.contains('is-buffering') || !Number.isFinite(media.duration) || media.duration <= 0) return;
        const target = requestedTime ?? media.currentTime, partCount = Math.max(1, Number(item.partCount) || 1), partDuration = media.duration / partCount;
        const partStart = Math.floor(Math.min(media.duration - .001, target) / partDuration) * partDuration;
        let end = partStart;
        for (let index = 0; index < media.buffered.length; index++) if (media.buffered.start(index) <= target + .25 && media.buffered.end(index) >= target) end = Math.max(end, media.buffered.end(index));
        // This is buffered media time inside the logical part, not Telegram's
        // transfer completion.  Keep 100% reserved for a canplay/playing event
        // so the UI never claims completion while the media element is stalled.
        const percent = Math.max(0, Math.min(99, (end - partStart) / partDuration * 100));
        bufferStatus.textContent = percent > 0 ? `正在加载当前分片 · ${Math.round(percent)}%` : '正在加载当前分片…';
    };
    const clearBuffering = () => { requestedTime = null; wrapper.classList.remove('is-buffering'); bufferStatus.hidden = true; };
    media.addEventListener('seeking', () => { wrapper.classList.add('is-buffering'); bufferStatus.hidden = false; updateBuffer(); });
    for (const eventName of ['waiting', 'stalled']) media.addEventListener(eventName, () => { wrapper.classList.add('is-buffering'); bufferStatus.hidden = false; updateBuffer(); });
    for (const eventName of ['progress', 'durationchange']) media.addEventListener(eventName, updateBuffer);
    for (const eventName of ['canplay', 'playing']) media.addEventListener(eventName, clearBuffering);
    media.addEventListener('timeupdate', () => {
        if (requestedTime === null && Number.isFinite(media.duration) && media.duration > 0) seek.value = String(Math.round(media.currentTime / media.duration * 1000));
        syncSeekThumb();
        time.textContent = `${formatDiskMediaTime(requestedTime ?? media.currentTime)} / ${formatDiskMediaTime(media.duration)}`;
        if (Date.now() - lastProgressSavedAt >= 1000) { lastProgressSavedAt = Date.now(); saveDiskMediaProgress(item, media); }
    });
    for (const eventName of ['pointermove', 'pointerenter', 'touchstart']) stage.addEventListener(eventName, showCenter, { passive: true });
    stage.addEventListener('click', event => { if (!event.target.closest('button')) toggle(); });
    download.onclick = async () => {
        download.disabled = true; download.classList.add('busy'); download.title = '正在下载';
        try {
            const blob = await window.DiskClient.read(item, { silentLoading: true });
            const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = item.name; anchor.click();
            if (audioCover && loadAudioCover) Promise.resolve(loadAudioCover(blob, item)).then(coverUrl => {
                if (!coverUrl || !audioCover?.isConnected) return;
                const image = document.createElement('img'); image.alt = `${item.name} 封面`; image.src = coverUrl; audioCover.replaceChildren(image);
            }).catch(() => {});
            setTimeout(() => URL.revokeObjectURL(url), 30000); download.title = '下载完成并已缓存'; updateDiskCacheLabels();
        } catch (error) {
            if (error?.name !== 'AbortError' && error?.message !== 'OPERATION_CANCELLED' && error?.message !== 'The user aborted a request.') alert(telegramDriveErrorText(error));
        } finally { download.disabled = false; download.classList.remove('busy'); }
    };
    const openShare = async event => {
        event.preventDefault(); event.stopPropagation();
        await shareDiskItems([item]);
    };
    share.onclick = event => openShare(event).catch(error => alert(telegramDriveErrorText(error)));
    syncSeekThumb();
    media.play().catch(() => syncPlay());
    return wrapper;
}
function createDiskPreviewImageLoading(item) {
    const loading = document.createElement('div'); loading.className = 'disk-preview-image-loading'; loading.setAttribute('role', 'status'); loading.setAttribute('aria-label', `正在加载图片 ${item.name}`);
    const spinner = document.createElement('span'); spinner.className = 'disk-preview-image-spinner'; spinner.setAttribute('aria-hidden', 'true'); loading.append(spinner);
    return loading;
}
function fitDiskPreviewImage(imageWidth, imageHeight, viewportWidth, viewportHeight, scale = 1, x = 0, y = 0) {
    if (!(imageWidth > 0 && imageHeight > 0 && viewportWidth > 0 && viewportHeight > 0)) return null;
    const fit = Math.min(viewportWidth / imageWidth, viewportHeight / imageHeight);
    const width = imageWidth * fit, height = imageHeight * fit;
    scale = Math.max(1, Math.min(6, scale));
    const maxX = Math.max(0, (width * scale - viewportWidth) / 2), maxY = Math.max(0, (height * scale - viewportHeight) / 2);
    return { width, height, scale, x: maxX ? Math.max(-maxX, Math.min(maxX, x)) : 0, y: maxY ? Math.max(-maxY, Math.min(maxY, y)) : 0 };
}
function wrapDiskPreviewImage(image, item) {
    const frame = document.createElement('div'); frame.className = 'disk-preview-image-frame';
    image.classList.add('disk-preview-image'); image.draggable = false;
    const controls = document.createElement('div'); controls.className = 'disk-preview-image-controls';
    const zoomButton = (icon, label) => {
        const button = document.createElement('button'); button.type = 'button'; button.setAttribute('aria-label', label); button.title = label;
        const iconImage = document.createElement('img'); iconImage.src = `/prompts/resources/magnifier-${icon}.svg`; iconImage.alt = ''; button.append(iconImage); controls.append(button); return button;
    };
    const zoomIn = zoomButton('plus', '放大图片'), zoomOut = zoomButton('minus', '缩小图片');
    let state = { scale: 1, x: 0, y: 0 }, gesture = null, disposed = false, moved = false;
    const pointers = new Map();
    function apply() {
        if (disposed) return;
        const fit = fitDiskPreviewImage(image.naturalWidth, image.naturalHeight, frame.clientWidth, frame.clientHeight, state.scale, state.x, state.y);
        zoomIn.disabled = !fit || fit.scale >= 6; zoomOut.disabled = !fit || fit.scale <= 1;
        if (!fit) return;
        state = fit;
        image.style.width = fit.width + 'px'; image.style.height = fit.height + 'px';
        image.style.transform = `translate(-50%,-50%) translate3d(${fit.x}px,${fit.y}px,0) scale(${fit.scale})`;
        frame.classList.toggle('is-zoomed', fit.scale > 1);
    }
    function startGesture() {
        const points = [...pointers.values()], rect = frame.getBoundingClientRect();
        const first = points[0], second = points[1];
        gesture = !first ? null : { scale: state.scale, x: state.x, y: state.y,
            centerX: (second ? (first.x + second.x) / 2 : first.x) - rect.left - rect.width / 2,
            centerY: (second ? (first.y + second.y) / 2 : first.y) - rect.top - rect.height / 2,
            distance: second ? Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)) : 0 };
    }
    zoomIn.onclick = () => { state.scale = Math.min(6, state.scale + .5); apply(); };
    zoomOut.onclick = () => { state.scale = Math.max(1, state.scale - .5); apply(); };
    frame.addEventListener('pointerdown', event => {
        if (event.target.closest('.disk-preview-image-controls') || (event.pointerType === 'mouse' && event.button !== 0)) return;
        if (event.pointerType === 'mouse' && state.scale <= 1) return;
        if (!pointers.size) { frame.dataset.gestureActive = String(state.scale > 1); moved = false; }
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.size > 1 || state.scale > 1) {
            frame.dataset.gestureActive = 'true'; event.preventDefault(); event.stopPropagation();
        }
        if (event.pointerType !== 'mouse' || state.scale > 1) frame.setPointerCapture(event.pointerId);
        startGesture();
    });
    frame.addEventListener('pointermove', event => {
        if (!pointers.has(event.pointerId) || !gesture) return;
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const points = [...pointers.values()], first = points[0], second = points[1];
        if (!second && state.scale <= 1) return;
        event.preventDefault(); event.stopPropagation();
        const rect = frame.getBoundingClientRect();
        const centerX = (second ? (first.x + second.x) / 2 : first.x) - rect.left - rect.width / 2;
        const centerY = (second ? (first.y + second.y) / 2 : first.y) - rect.top - rect.height / 2;
        const scale = second && gesture.distance ? Math.max(1, Math.min(6, gesture.scale * Math.hypot(first.x - second.x, first.y - second.y) / gesture.distance)) : gesture.scale;
        const ratio = scale / gesture.scale;
        state = { scale, x: centerX - (gesture.centerX - gesture.x) * ratio, y: centerY - (gesture.centerY - gesture.y) * ratio };
        moved = moved || Math.hypot(centerX - gesture.centerX, centerY - gesture.centerY) > 3 || Math.abs(scale - gesture.scale) > .01;
        apply();
    });
    const endPointer = event => {
        if (!pointers.delete(event.pointerId)) return;
        if (frame.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId);
        startGesture();
    };
    frame.addEventListener('pointerup', endPointer); frame.addEventListener('pointercancel', endPointer);
    frame.addEventListener('lostpointercapture', endPointer);
    frame.addEventListener('click', event => { if (moved) { event.preventDefault(); event.stopPropagation(); moved = false; } });
    const loading = createDiskPreviewImageLoading(item);
    const finish = () => { loading.remove(); apply(); };
    image.addEventListener('load', finish, { once: true });
    image.addEventListener('error', finish, { once: true });
    frame.append(image, loading, controls);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null;
    observer?.observe(frame); window.addEventListener('resize', apply);
    frame._disposeDiskImage = () => {
        disposed = true; observer?.disconnect(); window.removeEventListener('resize', apply);
        image.removeEventListener('load', finish); image.removeEventListener('error', finish);
        for (const id of pointers.keys()) if (frame.hasPointerCapture(id)) frame.releasePointerCapture(id);
        pointers.clear(); gesture = null;
    };
    apply();
    if (image.complete) queueMicrotask(finish);
    return frame;
}
async function renderDiskPreview() {
    disposeActiveDiskMedia();
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
        const type = getDiskPreviewType(item);
        if (type.startsWith('image/')) body.replaceChildren(createDiskPreviewImageLoading(item));
        const cached = await window.TelegramDriveCache?.get(item.id).catch(() => null);
        const blob = cached?.blob?.size === Number(item.size) ? cached.blob : null;
        let element;
        if (!blob && (/^(image|audio|video)\//.test(type) || type === 'application/pdf')) {
            element = /^(audio|video)\//.test(type) ? createDiskMediaPlayer(item, window.DiskClient.streamUrl(item, { purpose: 'media', fresh: true }), type) : document.createElement(type.startsWith('image/') ? 'img' : 'iframe');
            if (element.tagName === 'IFRAME') element.setAttribute('sandbox', '');
            if (element.tagName === 'IMG') element.alt = item.name;
            if (!/^(audio|video)\//.test(type)) { element.title = item.name; element.src = window.DiskClient.streamUrl(item, { purpose: 'preview' }); }
            if (element.tagName === 'IMG') element.addEventListener('load', () => {
                window.DiskClient.read(item, { silentLoading: true }).then(() => updateDiskCacheLabels()).catch(() => {});
            }, { once: true });
        } else {
            const materialized = blob || await window.DiskClient.read(item, { signal: previewAbort.signal });
            if (type.startsWith('text/')) {
                element = document.createElement('pre'); element.textContent = await materialized.slice(0, 2 * 1024 * 1024).text();
                if (materialized.size > 2 * 1024 * 1024) element.textContent += '\n（仅预览前 2 MB）';
            } else {
                previewURL = URL.createObjectURL(new Blob([materialized], { type }));
                element = /^(audio|video)\//.test(type) ? createDiskMediaPlayer(item, previewURL, type, materialized) : document.createElement(type.startsWith('image/') ? 'img' : 'iframe');
                if (element.tagName === 'IFRAME') element.setAttribute('sandbox', '');
                if (element.tagName === 'IMG') element.alt = item.name;
                if (!/^(audio|video)\//.test(type)) { element.title = item.name; element.src = previewURL; }
            }
        }
        if (element?.tagName === 'IMG') element = wrapDiskPreviewImage(element, item);
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
    overlay.innerHTML = '<div class="disk-loading-card"><div class="disk-loading-nav"><button id="diskLoadingPrev" type="button" aria-label="上一个任务">‹</button><span id="diskLoadingPosition"></span><button id="diskLoadingNext" type="button" aria-label="下一个任务">›</button></div><span class="disk-loading-spinner" aria-hidden="true"></span><strong id="diskLoadingTitle"></strong><div id="diskLoadingDetail" role="status" aria-live="polite"></div><progress id="diskLoadingProgress" max="100" aria-label="当前操作进度"></progress><button id="diskLoadingBackground" class="btn btn-secondary" type="button">后台继续</button><small>可左右切换任务；收起浮层不会取消操作。</small></div>';
    document.body.append(overlay);
    const title = $disk('diskLoadingTitle'), detail = $disk('diskLoadingDetail');
    const progress = $disk('diskLoadingProgress'), background = $disk('diskLoadingBackground');
    const previous = $disk('diskLoadingPrev'), next = $disk('diskLoadingNext'), position = $disk('diskLoadingPosition'), card = overlay.firstElementChild;
    let activities = [], jobs = [], candidates = [], previousFocus, pinnedJob = '', selectedIndex = 0, swipeStart = null;
    const activityIds = new WeakMap(); let activitySequence = 0;
    const dismissed = new Set();
    function hide() {
        if (overlay.hidden) return;
        const restoreFocus = overlay.contains(document.activeElement);
        overlay.hidden = true;
        if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    }
    const activityKey = activity => {
        if (activity.operationId) return 'job:' + activity.operationId;
        if (!activityIds.has(activity)) activityIds.set(activity, 'activity:' + ++activitySequence);
        return activityIds.get(activity);
    };
    function collectCandidates() {
        const activeJobs = jobs.filter(job => ['queued', 'running'].includes(job.status) && !window.DiskClient.isLoadingHidden?.(job.operation_id));
        const result = activeJobs.map(job => ({ key: 'job:' + job.operation_id, job, activity: activities.find(activity => activity.operationId === job.operation_id) }));
        for (const activity of activities) {
            const key = activityKey(activity);
            if (!result.some(item => item.key === key)) result.push({ key, activity });
        }
        candidates = result.filter(item => !dismissed.has(item.key));
        for (const key of dismissed) if (!result.some(item => item.key === key)) dismissed.delete(key);
        if (pinnedJob) {
            const pinnedIndex = candidates.findIndex(item => item.job?.operation_id === pinnedJob);
            if (pinnedIndex >= 0) selectedIndex = pinnedIndex;
            else pinnedJob = '';
        }
        selectedIndex = Math.max(0, Math.min(selectedIndex, candidates.length - 1));
    }
    function move(delta) {
        if (candidates.length < 2) return;
        pinnedJob = '';
        selectedIndex = (selectedIndex + delta + candidates.length) % candidates.length;
        render();
    }
    function render() {
        collectCandidates();
        const selected = candidates[selectedIndex];
        if (!selected) { hide(); return; }
        const { job, activity } = selected;
        title.textContent = job?.title || activity?.message || '正在处理网盘任务';
        const percent = typeof job?.percent === 'number' && Number.isFinite(job.percent) ? Math.max(0, Math.min(100, job.percent)) : null;
        const stages = [];
        if (Number.isFinite(job?.clientBytesReceived) && job.clientTotalBytes) stages.push(`浏览器 → 服务器 ${formatFileSize(job.clientBytesReceived)}/${formatFileSize(job.clientTotalBytes)}`);
        if (Number.isFinite(job?.telegramBytesUploaded) && job.telegramTotalBytes) stages.push(`服务器 → Telegram ${formatFileSize(job.telegramBytesUploaded)}/${formatFileSize(job.telegramTotalBytes)}`);
        detail.textContent = job
            ? [job.folderPath !== undefined ? `目录：${telegramDriveDisplayPath(job.folderPath)}` : '', job.message, job.phase, percent === null ? '' : Math.round(percent) + '%', stages.join(' · ') || (job.totalBytes ? formatFileSize(job.processedBytes) + ' / ' + formatFileSize(job.totalBytes) : '')].filter(Boolean).join(' · ')
            : [activity?.folderPath !== undefined ? `目录：${telegramDriveDisplayPath(activity.folderPath)}` : '', activity?.message || '正在处理，请稍候…'].filter(Boolean).join(' · ');
        if (percent === null) progress.removeAttribute('value'); else progress.value = percent;
        if (position) position.textContent = `${selectedIndex + 1} / ${candidates.length}`;
        if (previous) previous.disabled = candidates.length < 2;
        if (next) next.disabled = candidates.length < 2;
        if (overlay.hidden) { previousFocus = document.activeElement; overlay.hidden = false; background.focus({ preventScroll: true }); }
    }
    if (previous) previous.onclick = () => move(-1); if (next) next.onclick = () => move(1);
    card?.addEventListener('pointerdown', event => { swipeStart = event.isPrimary ? { x: event.clientX, y: event.clientY } : null; });
    card?.addEventListener('pointerup', event => {
        if (!swipeStart) return;
        const dx = event.clientX - swipeStart.x, dy = event.clientY - swipeStart.y; swipeStart = null;
        if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) move(dx < 0 ? 1 : -1);
    });
    card?.addEventListener('pointercancel', () => { swipeStart = null; });
    background.onclick = () => { pinnedJob = ''; for (const item of candidates) { dismissed.add(item.key); if (item.job?.operation_id) window.DiskClient.hideLoading?.(item.job.operation_id); } hide(); };
    // Do not let Enter/Escape/arrows reach the preview or the underlying edit dialog.
    document.addEventListener('keydown', event => {
        if (overlay.hidden) return;
        event.stopImmediatePropagation();
        if (event.key === 'Escape') { event.preventDefault(); background.click(); }
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1); }
        else if (event.key === 'Tab') { event.preventDefault(); background.focus(); }
        else if (event.target !== background) event.preventDefault();
    }, true);
    document.addEventListener('focusin', event => { if (!overlay.hidden && !overlay.contains(event.target)) background.focus({ preventScroll: true }); });
    window.DiskClient.subscribeActivity(value => {
        activities = value;
        render();
    });
    window.DiskClient.subscribe(value => { jobs = value; render(); });
    return () => {
        const activeUploads = jobs.filter(item => item.type === 'upload' && ['queued', 'running'].includes(item.status));
        const job = activeUploads[0];
        if (!job) return false;
        for (const activeJob of activeUploads) { dismissed.delete('job:' + activeJob.operation_id); window.DiskClient.showLoading?.(activeJob.operation_id); }
        pinnedJob = job.operation_id; render(); return true;
    };
}
function renderDiskTaskBubble(bubble, jobs, acknowledgedFailed = new Set()) {
    const uploads = jobs.filter(job => job.type === 'upload' && ['queued', 'running', 'failed'].includes(job.status) && !(job.status === 'failed' && acknowledgedFailed.has(job.operation_id)));
    // A failed upload stays visible even if another upload is running or has completed.
    const job = uploads.find(item => item.status === 'failed') || uploads[0];
    bubble.hidden = !job;
    if (!job) return;
    if (bubble.dataset) bubble.dataset.jobId = job.operation_id || '';
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
    $disk('diskPreviewClose').onclick = event => { event.preventDefault(); event.stopPropagation(); closeDiskPreview(); };
    $disk('diskPreviewPrev').onclick = () => stepDiskPreview(-1); $disk('diskPreviewNext').onclick = () => stepDiskPreview(1);
    document.addEventListener('keydown', event => {
        if (preview.hidden || event.target.matches?.('input,textarea,select') || event.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); closeDiskPreview(); }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); stepDiskPreview(event.key === 'ArrowLeft' ? -1 : 1); }
    });
    let touch;
    const imageGestureActive = event => event.target.closest?.('.disk-preview-image-frame')?.dataset.gestureActive === 'true';
    preview.addEventListener('touchstart', event => {
        if (imageGestureActive(event) || event.target.closest?.('.disk-media-controls,.disk-media-action-row,.disk-preview-image-controls,input,button')) { touch = null; return; }
        touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    }, { passive: true });
    preview.addEventListener('touchmove', event => { if (imageGestureActive(event) || event.touches.length !== 1) touch = null; }, { passive: true });
    preview.addEventListener('touchend', event => {
        if (imageGestureActive(event)) { touch = null; return; }
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
    const acknowledgedFailed = new Set();
    let latestJobs = [];
    try { for (const id of JSON.parse(localStorage.getItem('disk-acknowledged-failures') || '[]')) acknowledgedFailed.add(id); } catch (_) {}
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
        const failed = bubble.classList.contains('failed');
        if (failed) {
            for (const job of latestJobs) if (job.status === 'failed') acknowledgedFailed.add(job.operation_id);
            localStorage.setItem('disk-acknowledged-failures', JSON.stringify([...acknowledgedFailed].slice(-2000)));
            bubble.hidden = true;
        }
        closeDiskPreview();
        if (!failed) restoreLoading();
        try {
            if ($disk('telegramDriveOverlay').hidden) await openTelegramDrive();
            tasks.open = true; tasks.scrollIntoView({ block: 'nearest' });
        }
        catch (error) { alert(telegramDriveErrorText(error)); }
    };
    const previousStatuses = new Map();
    window.DiskClient.subscribe(jobs => {
        const changed = jobs.some(job => ['upload', 'repair'].includes(job.type) && ['queued', 'running'].includes(previousStatuses.get(job.operation_id)) && ['done', 'succeeded', 'completed', 'failed'].includes(job.status));
        for (const job of jobs) previousStatuses.set(job.operation_id, job.status);
        if (changed) {
            if ($disk('telegramDriveOverlay').hidden) telegramDriveContentStale = true;
            else refreshTelegramDriveContents().catch(error => showAppToast('列表刷新失败：' + telegramDriveErrorText(error)));
        }
        latestJobs = jobs;
        const ongoing = jobs.filter(job => ['queued', 'running'].includes(job.status));
        $disk('diskTaskCount').textContent = ongoing.length ? '· ' + ongoing.length + ' 项进行中' : '';
        $disk('diskTaskList').replaceChildren(...jobs.slice(0, 30).map(job => {
            const row = document.createElement('div'); row.className = 'disk-task-row';
            const title = document.createElement('strong'); title.textContent = (job.title ? job.title + ' · ' : '') + job.message;
            const detail = document.createElement('span'); detail.textContent = (job.folderPath !== undefined ? `目录：${telegramDriveDisplayPath(job.folderPath)} · ` : '') + job.phase + ' · ' + (job.status === 'failed' ? '已失败' : job.percent === null ? '处理中（进度未定）' : Math.round(job.percent) + '%') + (job.totalBytes ? ' · ' + formatFileSize(job.processedBytes) + '/' + formatFileSize(job.totalBytes) : '') + (job.errorCode ? ' · ' + telegramDriveErrorText(job.errorCode) : '');
            if (job.warnings?.length) detail.textContent += ' · 文件已保存，部分 Telegram 定位备注未能更新';
            row.append(title, detail);
            if (['queued', 'running'].includes(job.status)) {
                const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'disk-task-cancel'; cancel.textContent = '取消任务';
                cancel.onclick = async () => {
                    if (!await confirmTelegramDriveAction('取消网盘任务', `确定取消“${job.title || job.message}”吗？`, '取消任务')) return;
                    cancel.disabled = true;
                    try { await window.DiskClient.cancelOperation(job.operation_id); }
                    catch (error) { alert(telegramDriveErrorText(error)); cancel.disabled = false; }
                };
                row.append(cancel);
            }
            return row;
        }));
        tasks.hidden = !jobs.length;
        renderDiskTaskBubble(bubble, jobs, acknowledgedFailed);
        keepVisible();
    });
    getTelegramDriveIdentity().then(status => { if (status.identity) window.DiskClient.start(); }).catch(() => {});
}
function ownsTelegramDriveHistory() {
    return Boolean(telegramDriveMenuHistoryOpen || telegramDriveDialogHistoryOpen || diskPreviewHistoryOpen || telegramDriveHistorySession);
}
function handleTelegramDrivePopstate(event) {
    if (!ownsTelegramDriveHistory()) return;
    // Installed at script evaluation, before app.js (not in asynchronous init).
    // At Window's target phase, earlier listeners can run before capture ones.
    event.stopImmediatePropagation();
    if (telegramDriveMenuHistoryOpen && !event.state?.telegramDriveMenu) { closeTelegramDriveItemMenu({ fromHistory: true }); return; }
    if (telegramDriveDialogHistoryOpen && !event.state?.telegramDriveDialog) { closeTelegramDriveDialog(null, { fromHistory: true }); return; }
    if (diskPreviewHistoryClosing || (diskPreviewHistoryOpen && !event.state?.telegramDrivePreview)) {
        // Explicit Close only dismisses this preview. An asynchronously changed
        // destination entry must not turn that action into directory navigation.
        if (diskPreviewHistoryClosing && diskPreviewBaseState) history.replaceState(diskPreviewBaseState, '', location.href);
        closeDiskPreview({ fromHistory: true });
        return;
    }
    if (diskPreviewHistoryOpen) return;
    if (!telegramDriveHistorySession) return;
    if (event.state?.telegramDriveHistorySession !== telegramDriveHistorySession || !event.state?.telegramDriveOpen) return closeTelegramDrive();
    const overlay = document.getElementById('telegramDriveOverlay');
    if (overlay) { overlay.hidden = false; overlay.classList.add('active'); document.body.classList.add('telegram-drive-open'); }
    navigateTelegramDrive(event.state.telegramDrivePath || '', { fromHistory: true }).catch(error => alert(telegramDriveErrorText(error)));
}
function init(options = {}) {
    ({ formatFileSize = formatFileSize, showAppToast = showAppToast, historyLog = historyLog, audioCover: loadAudioCover = loadAudioCover } = options);
    window.DiskClient?.setAudioCoverExtractor?.(loadAudioCover);
    if (telegramDriveInitialized) return;
    telegramDriveInitialized = true;
    const driveDialog = document.getElementById('telegramDriveDialog');
    if (driveDialog && driveDialog.parentElement !== document.body) document.body.append(driveDialog);
    window.addEventListener('message', handleTelegramDriveOidcPopupMessage);
    window.addEventListener('disk-cache-changed', updateDiskCacheLabels);
    window.addEventListener('focus', updateDiskCacheLabels);
    document.getElementById('closeTelegramDriveBtn')?.addEventListener('click', () => closeTelegramDrive({ forget: true }));
    document.getElementById('minimizeTelegramDriveBtn')?.addEventListener('click', minimizeTelegramDrive);
    document.getElementById('telegramDriveDialogCloseBtn')?.addEventListener('click', () => closeTelegramDriveDialog(null));
    document.getElementById('telegramDriveDialog')?.addEventListener('click', event => {
        if (event.target !== event.currentTarget || event.currentTarget.dataset.dismissOnBackdrop !== 'true') return;
        event.preventDefault(); event.stopPropagation(); closeTelegramDriveDialog(null);
    });
    document.getElementById('telegramDriveRefreshBtn')?.addEventListener('click', () => renderTelegramDrive().catch(error => alert(telegramDriveErrorText(error))));
    document.getElementById('telegramDriveLogoutBtn')?.addEventListener('click', () => logoutTelegramDrive().catch(error => alert(telegramDriveErrorText(error))));
    document.getElementById('telegramDriveSearch')?.addEventListener('input', scheduleTelegramDriveSearch);
    document.getElementById('telegramDriveSearchAll')?.addEventListener('change', scheduleTelegramDriveSearch);
    document.getElementById('topbarDiskBtn')?.addEventListener('click', () => openTelegramDrive().catch(error => alert(telegramDriveErrorText(error))));
    saveDiskWindow(Boolean(diskWindowState.retained));
    initDiskBreadcrumbScroll();
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
        if (!menu.hidden && matchMedia('(max-width:600px)').matches) {
            const rect = event.currentTarget.getBoundingClientRect();
            menu.style.position = 'fixed'; menu.style.left = '12px'; menu.style.right = '12px';
            menu.style.top = Math.min(innerHeight - menu.offsetHeight - 12, rect.bottom + 7) + 'px';
        } else if (menu.hidden || !matchMedia('(max-width:600px)').matches) menu.removeAttribute('style');
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
        const driveMenu = document.getElementById('telegramDriveItemMenu');
        if (driveMenu && !driveMenu.hidden && !event.target.closest?.('#telegramDriveItemMenu,.telegram-drive-item-more')) closeTelegramDriveItemMenu();
    });
    const menuBackdrop = document.getElementById('telegramDriveItemMenuBackdrop');
    for (const eventName of ['pointerdown', 'click', 'contextmenu']) menuBackdrop?.addEventListener(eventName, event => {
        event.preventDefault(); event.stopPropagation();
        if (eventName === 'click') closeTelegramDriveItemMenu();
    });
    const list = document.getElementById('telegramDriveList');
    if (list) installContextGesture(list, event => {
        showTelegramDriveBackgroundMenu({ getBoundingClientRect: () => ({ left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY }) });
    }, null, { twoFingerTap: true, longPress: false, accept: event => !event.target.closest?.('.telegram-drive-item') });
    initDiskEnhancements();
    if (location.pathname === '/disk' || new URLSearchParams(location.search).get('disk') === '1') openTelegramDrive().catch(error => alert(telegramDriveErrorText(error)));
}
window.addEventListener('popstate', handleTelegramDrivePopstate, { capture: true });
window.DiskUI = { init, open: openTelegramDrive, close: closeTelegramDrive, ownsHistory: ownsTelegramDriveHistory, upload: uploadFilesToTelegramDrive, render: renderTelegramDrive, prompt: promptTelegramDriveText,
    async chooseDirectory(options = {}) {
        prepareTelegramDrivePicker();
        try { return await chooseTelegramDriveDestination([], { title: options.title || '选择网盘目录', confirmText: options.confirmText || '选择此目录', onCreateDirectory: options.onCreateDirectory }); }
        finally { document.getElementById('telegramDriveOverlay')?.classList.remove('telegram-drive-picker-mode'); }
    },
    revealUploadedDirectory: revealTelegramDriveUploadedDirectory,
    setExporter(fn) { diskExporter = fn; }, get path() { return telegramDrivePath; }, get navigationVersion() { return telegramDriveNavigationVersion; } };
})();
