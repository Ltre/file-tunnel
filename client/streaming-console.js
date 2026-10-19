(function (global) {
    'use strict';
    const t = value => global.TunnelI18n?.t(value) || value;
    const uid = () => crypto.randomUUID();
    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const userText = value => '<span class="message-content">' + esc(value) + '</span>';
    const kindOf = file => /^video\//.test(file.type) || /\.(mp4|webm|mkv|mov|m4v)$/i.test(file.name) ? 'video'
        : /^audio\//.test(file.type) || /\.(mp3|m4a|ogg|opus|wav|flac|aac)$/i.test(file.name) ? 'audio'
            : /^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.name) ? 'image'
                : /\.(md|markdown)$/i.test(file.name) ? 'markdown' : /\.txt$/i.test(file.name) || file.type === 'text/plain' ? 'text' : '';
    const labelKind = kind => t(({ local: '本机文件', disk: '网盘文件', tunnel: '隧道文件', video: '视频', audio: '音频', image: '图片', markdown: 'Markdown', text: 'TXT' })[kind] || kind);
    const stateLabel = value => t(({ public: '公开', invite: '仅限邀请', offline: '下线', restricted: '访问已结束', playing: '正在播放', stopped: '已停止', paused: '已暂停', waiting: '等待播放', reading: '正在展示', buffering: '缓冲中', blocked: '浏览器限制播放，请点击开始观看', error: '播放失败，请重试', sent: '已发送，待送达', delivered: '已送达，待接受', accepted: '已接受', rejected: '已拒绝', expired: '已到期', revoked: '已撤销' })[value] || value);
    let config, root, main, banner, initialized = false, ready, currentAccount = '', currentUser, renderVersion = 0, syncBusy = false;
    let ui = { view: 'discover', stationId: '', scroll: {}, drafts: {} }, pending = new Map(), channel = 'local', candidates = [], pickerVersion = 0;
    let diskScope = { accountId: '', diskSpace: '', path: '', mountId: '' }, tunnelScope = '', importBusy = false, lastList = [], dialog;
    const localFiles = new Map(), players = new Map(), noticeIds = new Map();
    const key = name => 'streaming:' + config.deviceId() + ':' + name;
    const account = () => global.DiskClient?.getAccount() || '';
    function saveUi() { if (!config) return; try { ui.importState = { pending: [...pending], channel, diskScope, tunnelScope }; localStorage.setItem(key('ui'), JSON.stringify(ui)); } catch (_) { notice('本机配置保存失败，请检查浏览器存储空间'); } }
    function saveConfig(stationId, value) { localStorage.setItem(key('station:' + stationId), JSON.stringify(value)); }
    function localConfig(stationId) { try { return JSON.parse(localStorage.getItem(key('station:' + stationId)) || 'null'); } catch (_) { return null; } }
    function notice(text, code = '') { if (banner) { banner.textContent = t(text) + (code ? ' [' + code + ']' : ''); banner.hidden = false; } }
    function error(cause) {
        const messages = { LOGIN_REQUIRED: '此操作需要登录账号', STREAM_OWNER_REQUIRED: '请切换或登录台的归属账号后管理', STREAM_SOURCE_LOGIN_REQUIRED: '请在创建设备重新登录归属账号，之后手动上线', STREAM_LOCAL_ONLY: '此操作只能在创建设备执行', STREAM_CONFLICT: '状态已更新，本次操作未应用，请刷新后重试', STREAM_KICKED: '此设备已被踢出，请联系创建者重新允许', STREAM_INVITATION_REQUIRED: '此台需要有效观看许可，请接受新邀请', STREAM_OFFLINE: '串流台已下线，书签仍保留', STREAM_START_INVALID: '播放起点超出可播范围，请检查节目参数', STREAM_DURATION_REQUIRED: '无法确定媒体时长，请预览并检查浏览器是否支持', STREAM_SOURCE_DELETED: '来源已删除，请移除或重新选择节目', STREAM_SOURCE_MISSING: '来源不可读取，请在供源设备重新选择文件', STREAM_PROVIDER_OFFLINE: '供源设备不在线或文件授权不可用', STREAM_DEVICE_DENIED: '设备身份校验失败，请检查本机存储与服务端记录', STREAM_INVITE_DEVICE: '这是发给其它设备的定向邀请', STREAM_INVITE_REVOKED: '邀请已撤销，请索取新邀请', STREAM_INVITE_EXPIRED: '邀请已到期，请索取新邀请', STREAM_MESSAGE_NOT_SAVED: '消息未保存，请检查隧道状态后重试' };
        notice(messages[cause.message] || '操作未完成，请检查状态后重试', cause.message);
    }
    function button(label, run, className = '') {
        const node = document.createElement('button'); node.type = 'button'; node.textContent = className.includes('message-content') ? label : t(label); node.className = className;
        node.onclick = async event => { event.stopPropagation(); if (node.disabled) return; node.disabled = true; try { await run(event); } catch (cause) { error(cause); } finally { node.disabled = false; } };
        return node;
    }
    async function request(url, method = 'GET', data, options = {}) {
        const headers = { 'X-Stream-Device': config.deviceId(), 'X-Stream-Key': localStorage.getItem(key('key')),
            ...(options.accountId ?? account() ? { 'X-Disk-Account': options.accountId ?? account() } : {}) };
        if (data !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetch('/api/streaming' + url, { method, headers, body: data === undefined ? undefined : JSON.stringify(data), cache: 'no-store', signal: options.signal });
        const result = await response.json(); if (!response.ok) throw Error(result.error || 'STREAM_REQUEST_FAILED'); return result;
    }
    function follow(stationId, accountId, receive, failure) {
        const controller = new AbortController();
        (async () => {
            while (!controller.signal.aborted) {
                try {
                    const response = await fetch('/api/streaming/stations/' + stationId + '/events', { headers: {
                        'X-Stream-Device': config.deviceId(), 'X-Stream-Key': localStorage.getItem(key('key')), ...(accountId ? { 'X-Disk-Account': accountId } : {})
                    }, cache: 'no-store', signal: controller.signal });
                    if (!response.ok) throw Error((await response.json()).error || 'STREAM_CONNECTION_FAILED');
                    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
                    try {
                        while (!controller.signal.aborted) {
                            const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
                            let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const record = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); if (record.error) throw Error(record.error); if (record.station) receive(record.station); }
                        }
                    } finally { reader.cancel().catch(() => {}); }
                } catch (cause) { if (!controller.signal.aborted) failure(cause); }
                if (!controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 2000));
            }
        })();
        return () => controller.abort();
    }
    function handleStore(mode, id, handle) {
        return new Promise((resolve, reject) => {
            const open = indexedDB.open('drop2tunnel-streaming-handles', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('handles');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result;
                try {
                    const tx = db.transaction('handles', mode === 'put' ? 'readwrite' : 'readonly');
                    const op = mode === 'put' ? tx.objectStore('handles').put(handle, key('file:' + id)) : tx.objectStore('handles').get(key('file:' + id));
                    let result; op.onsuccess = () => { result = op.result; };
                    tx.oncomplete = () => { db.close(); resolve(result); }; tx.onerror = () => { db.close(); reject(tx.error); };
                } catch (cause) { db.close(); reject(cause); }
            };
        });
    }
    async function localBlob(source) {
        const saved = localFiles.get(source.fileId);
        if (saved?.file) return saved.file;
        const handle = saved?.handle || await handleStore('get', source.fileId).catch(() => null);
        if (handle && await handle.queryPermission({ mode: 'read' }) === 'granted') {
            const file = await handle.getFile();
            if (file.name !== source.name || file.size !== source.size) throw Error('missing');
            localFiles.set(source.fileId, { handle, file }); return file;
        }
        throw Error('missing');
    }
    async function providerLoop() {
        while (initialized) {
            try {
                const work = await request('/provider-work');
                await Promise.all((work.requests || []).map(async task => {
                    let blob, failure;
                    try { blob = task.source.kind === 'local' ? (await localBlob(task.source)).slice(task.start, task.end + 1) : await config.readTunnel(task.source, { start: task.start, end: task.end }); }
                    catch (cause) { failure = cause.message === 'missing' ? 'missing' : 'unavailable'; }
                    const headers = { 'X-Stream-Device': config.deviceId(), 'X-Stream-Key': localStorage.getItem(key('key')), 'Content-Type': 'application/octet-stream' };
                    if (failure) headers['X-Stream-Error'] = failure;
                    await fetch('/api/streaming/provider-work/' + task.requestId, { method: 'POST', headers, body: failure ? new Uint8Array() : blob }).catch(() => {});
                }));
            } catch (_) { await new Promise(resolve => setTimeout(resolve, 3000)); }
        }
    }
    async function sync() {
        if (syncBusy || !initialized) return; syncBusy = true;
        const selected = account();
        try {
            const state = await request('/sync', 'POST', { follows: config.devices().filter(item => item.followed).map(item => item.deviceId), tunnels: await config.tunnels() });
            if (selected !== account()) return;
            const changed = currentAccount !== selected || currentUser?.id !== state.identity?.id;
            currentAccount = selected; currentUser = state.identity;
            if (root) root.querySelector('[data-sc-account]').textContent = state.identity ? state.identity.name || state.identity.username || state.identity.id : t('登录 / 管理账号');
            const inbox = await request('/inbox');
            for (const invite of inbox.invitations || []) {
                if (noticeIds.get(invite.id) === invite.status) continue;
                global.NotificationCenter?.add({ id: 'stream:' + invite.id, type: 'stream-invitation', title: t('串流邀请'),
                    body: invite.stationName + ' · ' + invite.deviceName + ' · ' + stateLabel(invite.status === 'sent' ? 'delivered' : invite.status), createdAt: invite.createdAt,
                    resolved: ['accepted', 'rejected', 'expired', 'revoked'].includes(invite.status) ? invite.status : '', data: invite });
                if (invite.status === 'sent') await request('/invitations/' + encodeURIComponent(invite.token) + '/delivered', 'POST', {});
                noticeIds.set(invite.id, invite.status);
            }
            if (changed && isOpen()) render();
            else if (isOpen() && ['discover', 'local', 'bookmarks', 'creator'].includes(ui.view)) refreshList();
        } catch (cause) { if (isOpen()) error(cause); }
        finally { syncBusy = false; }
    }
    function ensureUi() {
        if (root) return;
        root = document.createElement('section'); root.id = 'streamingConsole'; root.className = 'sc-overlay'; root.hidden = true;
        root.setAttribute('aria-label', t('串流控制台'));
        root.innerHTML = '<header class="sc-header"><strong>串流控制台</strong><button type="button" data-sc-account></button><span class="sc-running"></span><button type="button" data-sc-home>← 返回首页</button></header><div class="sc-workspace"><nav class="sc-nav"></nav><main class="sc-main"><div class="sc-banner" role="status" hidden></div><div class="sc-page"></div></main></div><footer class="sc-home-shortcuts"></footer>';
        document.body.append(root); main = root.querySelector('.sc-page'); banner = root.querySelector('.sc-banner');
        root.querySelector('[data-sc-home]').onclick = () => minimize();
        root.querySelector('[data-sc-account]').onclick = () => accountDialog();
        const nav = root.querySelector('.sc-nav');
        for (const [view, label] of [['discover', '发现的串流台'], ['local', '我创建的串流台'], ['bookmarks', '我订阅的串流台'], ['invitation', '通过邀请进入']]) {
            const b = button(label, () => navigate(view)); b.dataset.scView = view; nav.append(b);
        }
        nav.append(button('＋ 创建串流台', createStation, 'sc-primary'));
        for (const [view, label] of [['devices', '连接设备'], ['chat', '传输记录'], ['editor', '协同编辑']]) root.querySelector('footer').append(button(label, () => { minimize(); config.home(view); }));
        root.addEventListener('pointerdown', event => event.stopPropagation());
        root.addEventListener('touchstart', event => event.stopPropagation(), { passive: true });
        root.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
        for (const name of ['dragover', 'drop']) root.addEventListener(name, event => { event.preventDefault(); event.stopPropagation(); });
        root.addEventListener('paste', event => event.stopPropagation());
        root.querySelector('.sc-main').addEventListener('scroll', () => { ui.scroll[ui.view + ':' + ui.stationId] = root.querySelector('.sc-main').scrollTop; }, { passive: true });
        const parking = document.createElement('div'); parking.id = 'streamingParking'; parking.hidden = true; document.body.append(parking);
    }
    function isOpen() { return Boolean(root && !root.hidden); }
    async function open() {
        await ready; ensureUi();
        if (!isOpen()) { root.hidden = false; global.dispatchEvent(new Event('streaming-visibility-change')); history.pushState({ ...(history.state || {}), streamingConsole: true }, '', location.href); }
            const entry = document.getElementById('topbarStreamingBtn'); if (entry) entry.hidden = false; render(); sync();
    }
    function minimize(fromHistory = false) {
        if (!root || root.hidden) return;
        root.hidden = true; saveUi(); global.dispatchEvent(new Event('streaming-visibility-change'));
        if (!fromHistory && history.state?.streamingConsole) { const next = { ...history.state }; delete next.streamingConsole; history.replaceState(next, '', location.href); }
    }
    function navigate(view, stationId = '') {
        ui.view = view; ui.stationId = stationId; saveUi(); render();
    }
    function title(text) { const heading = document.createElement('h1'); heading.textContent = t(text); main.append(heading); return heading; }
    function parkPlayers() { const parking = document.getElementById('streamingParking'); for (const player of players.values()) parking.append(player.element); }
    async function render() {
        if (!isOpen()) return; const version = ++renderVersion; parkPlayers(); main.replaceChildren(); banner.hidden = true;
        root.querySelectorAll('[data-sc-view]').forEach(node => node.classList.toggle('selected', node.dataset.scView === ui.view));
        try {
            if (['discover', 'local', 'bookmarks', 'creator'].includes(ui.view)) { title(({ discover: '发现的串流台', local: '我创建的串流台', bookmarks: '我订阅的串流台', creator: '创作者公开台' })[ui.view]); await refreshList(version); }
            else if (ui.view === 'edit') editor();
            else if (ui.view === 'import') importer();
            else if (ui.view === 'watch') await watcher(version);
            else if (ui.view === 'access') await accessPage(version);
            else if (ui.view === 'invitation') invitationPage();
            if (version !== renderVersion) return;
            root.querySelector('.sc-main').scrollTop = ui.scroll[ui.view + ':' + ui.stationId] || 0;
            global.TunnelI18n?.translate(root);
        } catch (cause) { if (version === renderVersion) error(cause); }
    }
    async function accountDialog() {
        const data = await global.DiskClient.raw('/accounts', { accountId: '' });
        const body = document.createElement('div');
        for (const entry of data.accounts || []) {
            const b = button(entry.identity.name || entry.identity.username || entry.identity.id, async () => {
                if (entry.reauthRequired) { closeDialog(); minimize(); global.DiskUI.open(); return; }
                await global.DiskUI.switchAccount(entry.identity.id); closeDialog(); await sync();
            }); b.classList.add('message-content'); body.append(b);
        }
        body.append(button('登录 / 管理账号', () => { closeDialog(); minimize(); global.DiskUI.open(); })); showDialog('全局用户', body);
    }
    function showDialog(label, body) {
        closeDialog({ keepHistory: true });
        if (!history.state?.streamingDialog) history.pushState({ ...(history.state || {}), streamingDialog: true }, '', location.href);
        dialog = document.createElement('div'); dialog.className = 'sc-dialog';
        const card = document.createElement('section'), header = document.createElement('header'), name = document.createElement('strong'); name.textContent = t(label);
        card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', t(label));
        header.append(name, button('关闭', closeDialog)); card.append(header, body); dialog.append(card); document.body.append(dialog); return card;
    }
    function closeDialog({ keepHistory = false } = {}) {
        if (!dialog) return;
        dialog.querySelectorAll('video,audio').forEach(media => { media.pause(); media.removeAttribute('src'); }); dialog.remove(); dialog = null;
        if (!keepHistory && history.state?.streamingDialog) { const next = { ...history.state }; delete next.streamingDialog; history.replaceState(next, '', location.href); }
    }
    let listBusy = false;
    async function refreshList(version = renderVersion) {
        if (listBusy) return; listBusy = true;
        const view = ui.view, selected = account();
        try {
            const result = await request('/stations?kind=' + (view === 'creator' ? 'creator&ownerId=' + encodeURIComponent(ui.stationId) : view));
            if (version !== renderVersion || view !== ui.view || selected !== account()) return;
            lastList = result.stations; let list = main.querySelector('.sc-station-list');
            if (!list) { list = document.createElement('div'); list.className = 'sc-station-list'; main.append(list); }
            list.replaceChildren();
            if (!result.stations.length) { const p = document.createElement('p'); p.textContent = t(view === 'bookmarks' ? '暂无账号订阅书签' : '暂无可见串流台'); list.append(p); }
            for (const s of result.stations) {
                const row = document.createElement('article'); row.className = 'sc-station-row'; row.dataset.stationId = s.id;
                row.innerHTML = `<div class="sc-device"><span class="sc-device-icon">▣</span><div>${userText(s.deviceName)}<small>${t('来源设备')}</small></div></div><div class="sc-number"><small>${t('台号')}</small>${userText(s.number)}</div><div class="sc-station-title"><strong>${userText(s.name)}</strong><small>${s.owner ? t('归属用户') + ' · ' + userText(s.owner.name) : t('无归属')}</small></div><div><small>${t('文件节目单')}</small>${s.itemCount}</div><div><small>${t('可见性')}</small>${stateLabel(s.visibility)}</div><div><small>${t('全局状态')}</small>${stateLabel(s.playback.status)}${s.locked ? '<small>' + t('需要源设备登录') + '</small>' : ''}</div>`;
                const actions = document.createElement('div'); actions.className = 'sc-row-actions';
                actions.append(button(s.visibility === 'offline' ? '查看状态' : '打开观看', () => navigate('watch', s.id), 'sc-primary'));
                if (view === 'local') {
                    actions.append(button(s.manageable ? '编辑节目单' : '切换归属账号', () => s.manageable ? navigate('edit', s.id) : accountDialog()));
                    if (!s.ownerId && currentUser) actions.append(button('认领', async () => { await request('/stations/' + s.id + '/ownership', 'POST', { action: 'claim' }); await sync(); }));
                    if (s.manageable || s.locked) actions.append(button('删除台', async () => { if (!confirm(t('删除台及其配置，保留原始来源文件？'))) return; await request('/stations/' + s.id, 'DELETE'); localStorage.removeItem(key('station:' + s.id)); delete ui.drafts[s.id]; saveUi(); for (const [k, p] of players) if (k.startsWith(s.id + ':')) { p.close(); players.delete(k); } await refreshList(); }));
                } else if (view === 'bookmarks') actions.append(button('取消订阅', async () => { await request('/stations/' + s.id + '/bookmark', 'DELETE'); await refreshList(); }));
                if (s.owner) actions.append(button('创作者主页', () => navigate('creator', s.owner.id)));
                row.append(actions); list.append(row);
            }
        } finally { listBusy = false; }
    }
    async function createStation() {
        const creationId = localStorage.getItem(key('creating')) || uid(); localStorage.setItem(key('creating'), creationId);
        const s = await request('/stations', 'POST', { name: t('新串流台'), creationId });
        if (!localConfig(s.id)) saveConfig(s.id, { name: s.name, configVersion: s.configVersion, items: [], loop: true, countdown: 'bottom-right' });
        localStorage.removeItem(key('creating')); navigate('edit', s.id);
    }
    function draft() {
        if (!ui.drafts[ui.stationId]) { const saved = localConfig(ui.stationId); if (!saved) throw Error('STREAM_LOCAL_CONFIG_MISSING'); ui.drafts[ui.stationId] = saved; }
        return ui.drafts[ui.stationId];
    }
    function editor() {
        title('创建与编辑串流台'); const d = draft(), actions = document.createElement('div'); actions.className = 'sc-actions';
        const layout = document.createElement('div'); layout.className = 'sc-editor-grid'; const form = document.createElement('section'); form.className = 'sc-card';
        form.innerHTML = `<label>${t('串流台名称')}<input class="sc-name" maxlength="120" value="${esc(d.name)}"></label><label>${t('播放结束')}<select class="sc-loop"><option value="loop">${t('循环节目单')}</option><option value="stop">${t('播完停止')}</option></select></label><label>${t('静态项倒计时')}<select class="sc-countdown-choice">${['top-left', 'top-right', 'bottom-left', 'bottom-right', 'edge'].map((value, i) => '<option value="' + value + '">' + t(['左上', '右上', '左下', '右下', '边缘薄进度条'][i]) + '</option>').join('')}</select></label><p>${t('导入仅保存来源引用，不复制或保护原文件')}</p>`;
        form.querySelector('.sc-loop').value = d.loop ? 'loop' : 'stop'; form.querySelector('.sc-countdown-choice').value = d.countdown;
        form.oninput = () => { d.name = form.querySelector('.sc-name').value; d.loop = form.querySelector('.sc-loop').value === 'loop'; d.countdown = form.querySelector('.sc-countdown-choice').value; saveUi(); };
        const resources = document.createElement('section'); resources.className = 'sc-card';
        const heading = document.createElement('h2'); heading.textContent = t('已导入节目项'); resources.append(heading, button('导入可视资源', () => { pending = new Map(); channel = 'local'; candidates = []; navigate('import', ui.stationId); }));
        const list = document.createElement('div'); list.className = 'sc-program-list'; resources.append(list);
        function renderItems() {
            list.replaceChildren();
            d.items.forEach((item, index) => {
                const row = document.createElement('article'); row.className = 'sc-program'; row.dataset.itemId = item.id;
                row.innerHTML = `<div class="sc-program-name"><strong>${index + 1}. ${userText(item.name)}</strong><small>${labelKind(item.source?.kind)} · ${labelKind(item.kind)}</small></div><label>${t(item.duration ? '起始时刻（秒）' : '停留时间（秒）')}<input type="number" min="${item.duration ? 0 : .1}" step="0.1" value="${item.duration ? item.start || 0 : item.stay || 10}" aria-label="${t(item.duration ? '起始时刻（秒）' : '停留时间（秒）')}"></label>`;
                row.querySelector('input').oninput = event => { item[item.duration ? 'start' : 'stay'] = Number(event.target.value); saveUi(); };
                const toolbar = document.createElement('div'); toolbar.className = 'sc-actions';
                const move = delta => { const from = d.items.indexOf(item), to = Math.min(d.items.length - 1, Math.max(0, from + delta)); d.items.splice(from, 1); d.items.splice(to, 0, item); saveUi(); renderItems(); };
                const handle = button('拖动排序', () => {}); handle.className = 'sc-drag-handle';
                let start = null;
                handle.onpointerdown = event => { start = { y: event.clientY }; handle.setPointerCapture(event.pointerId); event.preventDefault(); };
                handle.onpointermove = event => { if (!start || Math.abs(event.clientY - start.y) < 8) return; const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.sc-program'); list.querySelectorAll('.sc-drop-target').forEach(node => node.classList.remove('sc-drop-target')); target?.classList.add('sc-drop-target'); };
                handle.onpointerup = event => { if (!start) return; start = null; const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.sc-program'); const to = d.items.findIndex(value => value.id === target?.dataset.itemId); if (to >= 0) { const from = d.items.indexOf(item); d.items.splice(from, 1); d.items.splice(to, 0, item); saveUi(); renderItems(); } };
                handle.onpointercancel = () => { start = null; list.querySelectorAll('.sc-drop-target').forEach(node => node.classList.remove('sc-drop-target')); };
                toolbar.append(handle, button('↑', () => move(-1)), button('↓', () => move(1)), button('预览', () => preview(item)), button('重复加入', () => { d.items.push({ ...structuredClone(item), id: uid() }); saveUi(); renderItems(); }), button('移除', () => { d.items = d.items.filter(value => value.id !== item.id); saveUi(); renderItems(); }));
                if (item.source?.kind === 'local') toolbar.append(button('重新选择文件', () => chooseLocalFile(item)));
                row.append(toolbar); list.append(row);
            });
        }
        renderItems(); layout.append(form, resources); main.append(layout);
        actions.append(button('保存节目单', async () => {
            const stationId = ui.stationId, submitted = structuredClone(d), actor = account();
            const result = await request('/stations/' + stationId, 'PUT', submitted, { accountId: actor });
            submitted.configVersion = result.configVersion; saveConfig(stationId, submitted); delete ui.drafts[stationId]; saveUi();
            if (ui.stationId === stationId && account() === actor) { navigate('watch', stationId); notice('节目单已保存'); }
        }, 'sc-primary'), button('返回列表', () => navigate('local'))); main.append(actions);
    }
    async function chooseLocalFile(replace) {
        const remember = async (files, handles = []) => {
            for (let index = 0; index < files.length; index++) {
                const file = files[index], kind = kindOf(file); if (!kind) { notice('已忽略不支持的文件类型'); continue; }
                if (replace && (file.name !== replace.name || file.size !== replace.size)) throw Error('STREAM_FILE_MISMATCH');
                const fileId = replace?.source.fileId || uid(), source = { kind: 'local', fileId, name: file.name, type: file.type, size: file.size };
                localFiles.set(fileId, { file, handle: handles[index] });
                if (handles[index]) await handleStore('put', fileId, handles[index]).catch(() => notice('文件引用仅在本次页面会话有效，重开后请重新选择'));
                if (!replace) { const candidate = { name: file.name, type: file.type, size: file.size, kind, source }; candidates.push(candidate); pending.set(candidateKey(candidate), candidate); }
            }
            saveUi(); if (!replace && ui.view === 'import') importer(); else notice('文件引用已恢复');
        };
        if (global.showOpenFilePicker) {
            try { const handles = await global.showOpenFilePicker({ multiple: !replace }); await remember(await Promise.all(handles.map(handle => handle.getFile())), handles); } catch (cause) { if (cause.name !== 'AbortError') throw cause; }
        } else {
            const input = document.createElement('input'); input.type = 'file'; input.multiple = !replace; input.accept = 'video/*,audio/*,image/*,.md,.markdown,.txt';
            input.onchange = () => remember([...input.files]).catch(error); input.click();
        }
    }
    const candidateKey = item => [item.source.kind, item.source.accountId || '', item.source.diskSpace || '', item.source.sessionId || '', item.source.messageId || '', item.source.fileId].join(':');
    async function importer() {
        if (ui.view !== 'import') return; const version = ++pickerVersion; main.replaceChildren(); title('导入可视资源');
        const channels = document.createElement('div'); channels.className = 'sc-tabs';
        for (const value of ['local', 'disk', 'tunnel']) channels.append(button(labelKind(value), () => { channel = value; candidates = value === 'local' ? [...pending.values()].filter(item => item.source.kind === 'local') : []; saveUi(); importer(); }, channel === value ? 'selected' : ''));
        main.append(channels); const controls = document.createElement('div'); controls.className = 'sc-source-controls'; const list = document.createElement('div'); list.className = 'sc-candidate-list'; const actions = document.createElement('div'); actions.className = 'sc-actions';
        main.append(controls, list, actions);
        function renderCandidates() {
            list.replaceChildren();
            for (const candidate of candidates) {
                const row = document.createElement('label'); row.className = 'sc-candidate';
                const check = document.createElement('input'); check.type = 'checkbox'; check.checked = pending.has(candidateKey(candidate));
                check.onchange = () => { if (check.checked) pending.set(candidateKey(candidate), candidate); else pending.delete(candidateKey(candidate)); saveUi(); count.textContent = t('待导入') + ' · ' + pending.size; };
                const text = document.createElement('span'); text.className = 'message-content'; text.textContent = candidate.name + ' · ' + labelKind(candidate.kind);
                row.append(check, text, button('预览', event => { event.preventDefault(); return preview(candidate); })); list.append(row);
            }
        }
        const count = document.createElement('strong'); count.textContent = t('待导入') + ' · ' + pending.size; actions.append(count);
        actions.append(button('确认导入', async () => {
            if (importBusy) return; importBusy = true; const d = draft(), stationId = ui.stationId;
            try {
                const additions = [];
                for (const candidate of pending.values()) {
                    const item = structuredClone(candidate); item.id = uid(); item.stay = 10; item.start = 0;
                    if (['video', 'audio'].includes(item.kind)) item.duration = await duration(candidate);
                    const grants = await config.tunnels(); item.source.tunnelGrants = Object.fromEntries(grants.map(entry => [entry.sessionId, entry.accessGrant])); additions.push(item);
                }
                if (ui.stationId !== stationId || ui.view !== 'import') return;
                d.items.push(...additions); pending.clear(); saveUi(); navigate('edit', stationId);
            } finally { importBusy = false; }
        }, 'sc-primary'), button('取消导入', () => { pending.clear(); navigate('edit', ui.stationId); }));
        if (channel === 'local') { controls.append(button('选择本机文件', () => chooseLocalFile())); renderCandidates(); return; }
        if (channel === 'disk') {
            const accounts = await global.DiskClient.raw('/accounts', { accountId: '' }); if (version !== pickerVersion) return;
            const selector = document.createElement('select'); selector.setAttribute('aria-label', t('来源账号'));
            for (const entry of accounts.accounts || []) if (!entry.reauthRequired) selector.add(new Option(entry.identity.name || entry.identity.username || entry.identity.id, entry.identity.id));
            diskScope.accountId ||= account() || selector.options[0]?.value || ''; selector.value = diskScope.accountId;
            controls.append(selector); selector.onchange = () => { diskScope = { accountId: selector.value, diskSpace: '', path: '', mountId: '' }; importer(); };
            if (!selector.value) { notice('导入网盘资源需要登录来源账号'); return; }
            const spaces = await global.DiskClient.raw('/spaces', { accountId: diskScope.accountId, diskSpace: '' }); if (version !== pickerVersion) return;
            const partition = document.createElement('select'); partition.setAttribute('aria-label', t('来源分区'));
            for (const space of spaces.spaces || []) partition.add(new Option(space.name, space.scopeKey ?? space.diskSpace ?? ''));
            partition.value = diskScope.diskSpace; controls.append(partition); partition.onchange = () => { diskScope.diskSpace = partition.value; diskScope.path = ''; diskScope.mountId = ''; importer(); };
            const context = { accountId: diskScope.accountId, diskSpace: diskScope.diskSpace, requestBase: '/api/telegram/drive' + (diskScope.mountId ? '/mount-scope/' + encodeURIComponent(diskScope.mountId) : '') };
            const result = await global.DiskClient.raw('/list?path=' + encodeURIComponent(diskScope.path), context); if (version !== pickerVersion) return;
            const path = document.createElement('span'); path.className = 'message-content'; path.textContent = '/' + diskScope.path; controls.append(path);
            controls.append(button('上级目录', () => { if (!diskScope.path) diskScope.mountId = ''; diskScope.path = diskScope.path.split('/').slice(0, -1).join('/'); importer(); }));
            for (const folder of result.folders || []) controls.append(button('▱ ' + folder.name, () => { diskScope.path = folder.path; importer(); }, 'message-content'));
            for (const mount of result.mounts || []) controls.append(button('▱ ' + mount.name, () => { diskScope.mountId = mount.id; diskScope.path = ''; importer(); }, 'message-content'));
            candidates = (result.files || []).filter(file => kindOf(file)).map(file => ({ name: file.name, type: file.type, size: file.size, kind: kindOf(file), source: { kind: 'disk', accountId: diskScope.accountId, diskSpace: diskScope.diskSpace, fileId: file.id } }));
        } else {
            const tunnels = await config.tunnels(); if (version !== pickerVersion) return;
            const selector = document.createElement('select'); selector.setAttribute('aria-label', t('来源隧道'));
            for (const entry of tunnels) selector.add(new Option(entry.name || entry.sessionId, entry.sessionId));
            tunnelScope ||= tunnels[0]?.sessionId || ''; selector.value = tunnelScope; controls.append(selector);
            selector.onchange = () => { tunnelScope = selector.value; importer(); };
            const selected = tunnels.find(entry => entry.sessionId === selector.value); if (!selected) return;
            const result = await request('/tunnel-candidates', 'POST', selected); if (version !== pickerVersion) return;
            candidates = result.candidates;
            const records = [...new Set(candidates.map(item => item.source.messageId))];
            for (const recordId of records) controls.append(button(t('选择记录') + ' ' + recordId.slice(-6), () => { for (const item of candidates.filter(item => item.source.messageId === recordId)) pending.set(candidateKey(item), item); saveUi(); count.textContent = t('待导入') + ' · ' + pending.size; renderCandidates(); }, 'message-content'));
        }
        const randomCount = document.createElement('input'); randomCount.type = 'number'; randomCount.min = 1; randomCount.max = candidates.length; randomCount.value = Math.min(3, candidates.length); randomCount.setAttribute('aria-label', t('随机导入数量'));
        controls.append(randomCount, button('从当前范围随机选取', () => {
            const amount = Number(randomCount.value); if (!Number.isInteger(amount) || amount < 1 || amount > candidates.length) throw Error('STREAM_PARAMETER_INVALID');
            const pool = candidates.slice(); for (let index = pool.length - 1; index > 0; index--) { const other = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1); [pool[index], pool[other]] = [pool[other], pool[index]]; }
            for (const candidate of pool.slice(0, amount)) pending.set(candidateKey(candidate), candidate); saveUi(); count.textContent = t('待导入') + ' · ' + pending.size; renderCandidates();
        }));
        renderCandidates();
    }
    async function sourceUrl(item) {
        const source = structuredClone(item.source); source.tunnelGrants = Object.fromEntries((await config.tunnels()).map(entry => [entry.sessionId, entry.accessGrant]));
        return (await request('/preview', 'POST', { source })).url;
    }
    async function duration(item) {
        const url = await sourceUrl(item);
        return new Promise((resolve, reject) => {
            const media = document.createElement(item.kind), timer = setTimeout(() => finish(Error('STREAM_DURATION_REQUIRED')), 30000);
            function finish(cause) { clearTimeout(timer); media.onloadedmetadata = media.onerror = null; const value = media.duration; media.removeAttribute('src'); media.load(); cause ? reject(cause) : resolve(value); }
            media.preload = 'metadata'; media.onloadedmetadata = () => finish(Number.isFinite(media.duration) && media.duration > 0 ? null : Error('STREAM_DURATION_REQUIRED')); media.onerror = () => finish(Error('STREAM_DURATION_REQUIRED')); media.src = url;
        });
    }
    async function preview(item) {
        const url = await sourceUrl(item), body = document.createElement('div'); body.className = 'sc-preview';
        if (['video', 'audio', 'image'].includes(item.kind)) {
            const node = document.createElement(item.kind === 'image' ? 'img' : item.kind); node.src = url; if (item.kind !== 'image') node.controls = true; else node.alt = item.name; body.append(node);
        } else { const response = await fetch(url, { cache: 'no-store' }); if (!response.ok) throw Error('STREAM_SOURCE_UNAVAILABLE'); const pre = document.createElement('pre'); pre.textContent = await response.text(); body.append(pre); }
        showDialog('资源预览', body);
    }
    async function watcher(version) {
        title('观看串流台'); const s = lastList.find(item => item.id === ui.stationId);
        let snapshot;
        try {
            if (s?.manageable || s?.local || !s) {
                try { snapshot = await request('/stations/' + ui.stationId + '?manage=1'); }
                catch (cause) { if (cause.message !== 'STREAM_OWNER_REQUIRED') throw cause; snapshot = await request('/stations/' + ui.stationId); }
            } else snapshot = await request('/stations/' + ui.stationId);
        }
        catch (cause) { if (s?.visibility === 'offline') { offlinePage(s); return; } throw cause; }
        if (version !== renderVersion) return;
        const info = document.createElement('div'); info.className = 'sc-watch-info'; info.innerHTML = `<strong>${userText(snapshot.number + ' · ' + snapshot.name)}</strong><p>${t('来源设备')} · ${userText(snapshot.deviceName)}${snapshot.owner ? ' · ' + t(snapshot.owner.id === currentUser?.id ? '创建者为自己' : '归属用户') + ' · ' + userText(snapshot.owner.name) : ' · ' + t('无归属')}</p>`;
        main.append(info); const layout = document.createElement('div'); layout.className = 'sc-watch-grid'; const stage = document.createElement('div'); const aside = document.createElement('aside'); aside.className = 'sc-card'; layout.append(stage, aside); main.append(layout);
        const actions = document.createElement('div'); actions.className = 'sc-actions'; main.append(actions);
        actions.append(button('订阅书签', async () => { await request('/stations/' + snapshot.id + '/bookmark', 'PUT'); notice('已添加账号书签'); }), button('复制观看链接', async () => { await navigator.clipboard.writeText(location.origin + '/?stream=' + snapshot.id); notice('观看链接已复制'); }), button('返回列表', () => navigate('discover')));
        if (snapshot.owner) actions.append(button('创作者主页', () => navigate('creator', snapshot.owner.id)));
        const playerKey = snapshot.id + ':' + account(); let player = players.get(playerKey);
        const fillInfo = value => {
            if (ui.view !== 'watch' || ui.stationId !== value.id || version !== renderVersion) return;
            aside.replaceChildren(); const heading = document.createElement('h2'); heading.textContent = t('全局状态') + ' · ' + stateLabel(['offline', 'restricted'].includes(value.visibility) ? value.visibility : value.playback.status); aside.append(heading);
            for (const item of value.items) {
                const row = document.createElement('p'); row.className = 'message-content'; row.textContent = (item.id === value.playback.itemId ? '▶ ' : '') + item.name + (item.unavailable ? ' · ' + t('来源不可用') : '');
                if (value.manageable) row.append(button('切换节目', () => command('select', { itemId: item.id }))); aside.append(row);
            }
            if (value.manageable && value.viewers?.length) { const h = document.createElement('h3'); h.textContent = t('实际观看设备'); aside.append(h);
                for (const viewer of value.viewers) { const p = document.createElement('p'); p.className = 'message-content'; p.textContent = viewer.name + ' · ' + stateLabel(viewer.status) + ' · ' + viewer.position.toFixed(1) + 's'; if (viewer.deviceId !== value.deviceId) p.append(button('踢出', () => kick(value.id, viewer.deviceId))); aside.append(p); }
            }
        };
        async function command(action, extra = {}) {
            const latest = player?.snapshot() || snapshot;
            const result = await request('/stations/' + snapshot.id + '/control', 'POST', { action, version: latest.playback.version, ...extra }); player?.apply(result); fillInfo(result);
        }
        if (snapshot.visibility !== 'offline') {
            if (!player) { const fixedAccount = account(); player = global.StreamingPlayer.create({ stationId: snapshot.id,
                request: (url, method, data) => request(url, method, data, { accountId: fixedAccount }), subscribe: (receive, failure) => follow(snapshot.id, fixedAccount, receive, failure), onState: value => { player.onView?.(value); }, onError: cause => { if (ui.stationId === snapshot.id && isOpen()) error(cause); } }); players.set(playerKey, player); }
            player.onView = fillInfo; stage.append(player.element); player.apply(snapshot);
        } else { stage.textContent = t('串流台已下线，书签仍保留'); fillInfo(snapshot); }
        if (snapshot.manageable) {
            const globalControls = document.createElement('div'); globalControls.className = 'sc-global-controls'; const scope = document.createElement('strong'); scope.textContent = t('全台控制，影响所有跟随者'); globalControls.append(scope);
            for (const [action, label] of [['previous', '上一个'], ['play', '全台播放'], ['pause', '全台暂停'], ['next', '下一个'], ['stop', '全台停止'], ['retry', '重新校验来源']]) globalControls.append(button(label, () => command(action)));
            const seek = document.createElement('input'); seek.type = 'number'; seek.min = 0; seek.step = .1; seek.value = snapshot.playback.position.toFixed(1); seek.setAttribute('aria-label', t('全局节目进度（秒）'));
            globalControls.append(seek, button('调整全局进度', () => command('seek', { position: Number(seek.value) })), button('后退 10 秒', () => command('seek', { position: Math.max(0, (player?.snapshot() || snapshot).playback.position - 10) })), button('快进 10 秒', () => { const state = player?.snapshot() || snapshot, item = state.items.find(item => item.id === state.playback.itemId); return command('seek', { position: Math.min(item?.duration ? item.duration - item.start : item?.stay || 0, state.playback.position + 10) }); }));
            main.append(globalControls); actions.append(button('邀请与可见性', () => navigate('access', snapshot.id)));
            if (snapshot.local) actions.append(button('编辑节目单', () => navigate('edit', snapshot.id)));
        }
    }
    function offlinePage(s) {
        const p = document.createElement('p'); p.textContent = t('串流台已下线，书签仍保留'); main.append(p);
        if (s.manageable) main.append(button('邀请与可见性', () => navigate('access', s.id)));
        main.append(button('返回列表', () => navigate('local')));
    }
    async function kick(stationId, deviceId) { if (confirm(t('终止此设备的观看并阻止旧入口重新进入？'))) { await request('/stations/' + stationId + '/access', 'POST', { deviceId, allow: false }); notice('已终止该设备对本台的访问'); } }
    async function accessPage(version) {
        title('邀请与可见性'); const stationId = ui.stationId, s = await request('/stations/' + stationId + '?manage=1'); if (version !== renderVersion) return;
        const visibility = document.createElement('section'); visibility.className = 'sc-card'; const h = document.createElement('h2'); h.textContent = t('可见性'); visibility.append(h);
        for (const value of ['public', 'invite', 'offline']) visibility.append(button(stateLabel(value), async () => {
            const reset = value === 'invite' && (s.visibility === 'public' || s.visibility === 'offline');
            if (reset && !confirm(t('改为仅邀请会退出旧观看端、撤销旧观看资格及此前所有邀请，保留书签。继续？'))) return;
            if (value === 'offline' && !confirm(t('下线将停止服务并保留书签，继续？'))) return;
            const fresh = await request('/stations/' + stationId + '?manage=1'); await request('/stations/' + stationId + '/visibility', 'POST', { visibility: value, version: fresh.playback.version, confirmReset: reset }); render();
        }, s.visibility === value ? 'selected' : ''));
        if (s.local && s.ownerId) visibility.append(button('放弃归属', async () => { if (confirm(t('放弃台归属，保留普通观看许可和书签？'))) { await request('/stations/' + stationId + '/ownership', 'POST', { action: 'release' }); navigate('local'); } }));
        main.append(visibility); const inviteForm = document.createElement('section'); inviteForm.className = 'sc-card';
        inviteForm.innerHTML = `<h2>${t('生成与发送邀请')}</h2><label>${t('有效期（小时，留空为不过期）')}<input class="sc-hours" type="number" min="0.017" step="1" value="24"></label><label><input type="checkbox" class="sc-thumbnail">${t('附带当前媒体缩略图（可用时）')}</label><div class="sc-device-choices"></div><div class="sc-actions"></div>`;
        const choices = inviteForm.querySelector('.sc-device-choices');
        for (const device of config.devices().filter(device => device.deviceId !== config.deviceId())) { const label = document.createElement('label'); const check = document.createElement('input'); check.type = 'checkbox'; check.value = device.deviceId; label.append(check); const name = document.createElement('span'); name.className = 'message-content'; name.textContent = device.name || device.deviceName || device.deviceId; label.append(name); choices.append(label); }
        const input = () => ({ hours: inviteForm.querySelector('.sc-hours').value === '' ? null : Number(inviteForm.querySelector('.sc-hours').value), thumbnail: inviteForm.querySelector('.sc-thumbnail').checked ? thumbnail(stationId) : null });
        let generalRequestId = uid(); const directRequests = new Map();
        inviteForm.querySelector('.sc-actions').append(button('生成通用邀请', async () => { const result = await request('/stations/' + stationId + '/invitations', 'POST', { ...input(), requestId: generalRequestId }); generalRequestId = uid(); await showInvite(result); }), button('发送定向邀请', async () => {
            const selected = [...choices.querySelectorAll('input:checked')].map(node => node.value); if (!selected.length) { notice('请选择邀请设备'); return; }
            for (const deviceId of selected) { if (!directRequests.has(deviceId)) directRequests.set(deviceId, uid());
                await request('/stations/' + stationId + '/invitations', 'POST', { ...input(), deviceId, requestId: directRequests.get(deviceId) });
                directRequests.delete(deviceId); choices.querySelector('input[value="' + CSS.escape(deviceId) + '"]').checked = false;
            }
            notice('邀请已发送，等待对方接收与处理'); await renderInvites();
        })); main.append(inviteForm);
        const invitationList = document.createElement('section'); invitationList.className = 'sc-card'; main.append(invitationList);
        async function renderInvites() {
            const result = await request('/stations/' + stationId + '/invitations'); if (version !== renderVersion) return; invitationList.replaceChildren();
            for (const invite of result.invitations) { const row = document.createElement('div'); row.className = 'sc-invite-row'; const label = document.createElement('span'); label.className = 'message-content'; label.textContent = (invite.deviceId || t('通用邀请')) + ' · ' + stateLabel(invite.status) + ' · ' + (invite.expiresAt ? new Date(invite.expiresAt).toLocaleString() : t('不过期')); row.append(label, button('查看邀请', () => showInvite(invite)), button('撤销', async () => { await request('/stations/' + stationId + '/invitations/' + invite.id, 'DELETE'); await renderInvites(); })); invitationList.append(row); }
        }
        async function showInvite(invite) {
            const body = document.createElement('div'), input = document.createElement('textarea'); input.readOnly = true; input.value = location.origin + '/?stream_invite=' + invite.token; input.setAttribute('aria-label', t('邀请链接')); body.append(input);
            body.append(button('复制邀请链接', async () => { await navigator.clipboard.writeText(input.value); notice('邀请链接已复制'); }), button('复制邀请码', async () => { await navigator.clipboard.writeText(invite.token); notice('邀请码已复制'); }));
            if (!invite.deviceId) {
                const selector = document.createElement('select'), tunnels = await config.tunnels(); for (const entry of tunnels) selector.add(new Option(entry.name || entry.sessionId, entry.sessionId)); selector.setAttribute('aria-label', t('目标隧道')); body.append(selector);
                const submissionId = uid(); body.append(button('转发到隧道', async () => {
                    const selected = tunnels.find(entry => entry.sessionId === selector.value); if (!selected) throw Error('STREAM_TUNNEL_DENIED');
                    const sent = await request('/tunnel-markdown', 'POST', { ...selected, inviteToken: invite.token, messageId: submissionId, deviceName: config.deviceName() });
                    await config.onMessage?.(sent.message, selected.sessionId); notice('邀请消息已发送，接收者可自行接受'); closeDialog();
                }));
            }
            showDialog('邀请详情', body); await renderInvites();
        }
        await renderInvites();
        const blocked = document.createElement('section'); blocked.className = 'sc-card';
        for (const deviceId of s.blocked || []) { const row = document.createElement('div'); row.className = 'sc-invite-row'; row.innerHTML = userText(deviceId); row.append(button('重新允许', async () => { await request('/stations/' + stationId + '/access', 'POST', { deviceId, allow: true }); render(); })); blocked.append(row); }
        main.append(blocked, button('返回观看', () => navigate('watch', stationId)));
    }
    function thumbnail(stationId) {
        const element = [...players.entries()].find(([key]) => key.startsWith(stationId + ':'))?.[1]?.element.querySelector('video,img');
        if (!element) return null;
        try { const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90; canvas.getContext('2d').drawImage(element, 0, 0, 160, 90); return canvas.toDataURL('image/jpeg', .6); } catch (_) { return null; }
    }
    function invitationPage() {
        title('通过邀请进入'); const input = document.createElement('textarea'); input.placeholder = t('粘贴邀请链接或邀请码'); input.setAttribute('aria-label', t('邀请链接或邀请码')); main.append(input, button('核对邀请', () => inspectInvitation(input.value)));
    }
    async function inspectInvitation(value) {
        const token = value.includes('stream_invite=') ? new URL(value, location.origin).searchParams.get('stream_invite') : value.trim();
        const result = await request('/invitations/' + encodeURIComponent(token)), body = document.createElement('div');
        body.innerHTML = `<h2>${userText(result.station.name)}</h2><p>${t('来源设备')} · ${userText(result.station.deviceName)}</p><p>${result.deviceId ? t('仅当前被邀请设备可接受') : t('通用邀请可供多个设备使用')}</p><p>${t('接受取得观看许可，不自动订阅')}</p>`;
        if (result.thumbnail) { const image = document.createElement('img'); image.className = 'sc-invite-thumbnail'; image.src = result.thumbnail; image.alt = t('邀请缩略图'); body.append(image); }
        for (const [decision, label] of [['accept', '接受邀请'], ['reject', '拒绝']]) body.append(button(label, async () => { const response = await request('/invitations/' + encodeURIComponent(token), 'POST', { decision }); closeDialog(); if (decision === 'accept') { navigate('watch', response.stationId); notice('已取得观看许可'); } else notice('已拒绝邀请'); await sync(); }));
        showDialog('接收邀请', body);
    }
    async function notification(item, action) {
        await ready; const invite = item.data;
        if (action === 'open' || action === 'accept') {
            global.NotificationCenter?.close(true);
            const next = { ...(history.state || {}) }; delete next.notificationCenter; history.replaceState(next, '', location.href);
        }
        if (action === 'open') { await open(); await inspectInvitation(invite.token); return; }
        const response = await request('/invitations/' + encodeURIComponent(invite.token), 'POST', { decision: action === 'accept' ? 'accept' : 'reject' });
        if (response.accepted) { await open(); navigate('watch', response.stationId); } await sync();
    }
    async function compose() {
        await ready; const body = document.createElement('div'), input = document.createElement('textarea'); input.rows = 12; input.placeholder = t('输入 Markdown，可插入隧道媒体引用');
        const stored = key('markdown-draft:' + config.currentTunnel()); input.value = localStorage.getItem(stored) || ''; input.oninput = () => localStorage.setItem(stored, input.value); body.append(input);
        const tunnels = await config.tunnels(), context = tunnels.find(entry => entry.sessionId === config.currentTunnel()); if (!context) throw Error('STREAM_TUNNEL_DENIED');
        const messageId = localStorage.getItem(stored + ':id') || uid(); localStorage.setItem(stored + ':id', messageId);
        const previewNode = document.createElement('div'); previewNode.className = 'sc-document message-content';
        body.append(button('插入隧道媒体', async () => {
            const result = await request('/tunnel-resources', 'POST', context);
            const list = document.createElement('div');
            for (const item of result.candidates.filter(item => item.source.fileId !== 'record')) list.append(button(item.name, () => { const s = item.source; input.value += '\n![' + item.name.replace(/[\[\]]/g, '') + '](tunnel-blob:' + s.sessionId + '/' + s.messageId + '/' + s.fileId + ')\n'; input.oninput(); closeDialog(); showDialog('编写 Markdown 消息', body); }, 'message-content'));
            showDialog('选择隧道媒体', list);
        }), button('预览', () => global.TunnelMarkdown.render(previewNode, input.value)), button('发送 Markdown', async () => {
            const sent = await request('/tunnel-markdown', 'POST', { ...context, body: input.value, messageId, deviceName: config.deviceName(), tunnelGrants: Object.fromEntries(tunnels.map(entry => [entry.sessionId, entry.accessGrant])) });
            await config.onMessage?.(sent.message, context.sessionId);
            localStorage.removeItem(stored); localStorage.removeItem(stored + ':id'); closeDialog(); config.toast(t('Markdown 消息已发送'));
        }, 'sc-primary'), previewNode);
        showDialog('编写 Markdown 消息', body);
    }
    function init(options) {
        if (initialized) return ready; config = options; initialized = true;
        const entryUrl = new URL(location.href);
        try { ui = { ...ui, ...JSON.parse(localStorage.getItem(key('ui')) || '{}') }; } catch (_) {}
        if (ui.importState) { pending = new Map(ui.importState.pending || []); channel = ui.importState.channel || 'local'; diskScope = ui.importState.diskScope || diskScope; tunnelScope = ui.importState.tunnelScope || ''; candidates = [...pending.values()].filter(item => item.source.kind === channel); }
        ready = (async () => {
            let secret = localStorage.getItem(key('key')); if (!secret) { secret = uid().replace(/-/g, '') + uid().replace(/-/g, ''); localStorage.setItem(key('key'), secret); }
            const response = await fetch('/api/streaming/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: config.deviceId(), key: secret, name: config.deviceName() }) });
            if (!response.ok) throw Error('STREAM_DEVICE_DENIED');
            providerLoop(); await sync();
        })();
        ready.catch(cause => { initialized = false; config.toast(t('串流模块初始化失败') + ' [' + cause.message + ']'); });
        document.getElementById('streamingConsoleBtn')?.addEventListener('click', () => { document.getElementById('connectionHeaderMenu').hidden = true; open().catch(error); });
        document.getElementById('topbarStreamingBtn')?.addEventListener('click', () => open().catch(error));
        document.getElementById('sendMarkdownBtn')?.addEventListener('click', () => compose().catch(error));
        global.addEventListener('focus', sync); setInterval(sync, 5000);
        global.addEventListener('popstate', event => {
            const restore = () => { if (isOpen() && !history.state?.streamingConsole) history.pushState({ ...(history.state || {}), streamingConsole: true }, '', location.href); };
            if (dialog) { closeDialog(); restore(); return; }
            const fullscreen = document.querySelector('.sc-media-fullscreen');
            if (fullscreen) { fullscreen.classList.remove('sc-media-fullscreen'); restore(); return; }
            if (!isOpen()) return;
            const parent = { import: 'edit', edit: 'local', access: 'watch', watch: 'discover', creator: 'discover', invitation: 'discover' }[ui.view];
            if (parent) { navigate(parent, ['edit', 'watch'].includes(parent) ? ui.stationId : ''); restore(); }
            else minimize(true);
        });
        document.addEventListener('keydown', event => { if (event.key !== 'Escape') return; if (dialog) { event.preventDefault(); event.stopImmediatePropagation(); closeDialog(); } else if (document.fullscreenElement?.classList.contains('sc-player')) { event.stopImmediatePropagation(); } else if (document.querySelector('.sc-media-fullscreen')) { document.querySelector('.sc-media-fullscreen').classList.remove('sc-media-fullscreen'); } else if (isOpen()) { event.preventDefault(); minimize(); } }, true);
        ready.then(async () => { const url = entryUrl; if (url.searchParams.has('stream')) { await open(); navigate('watch', url.searchParams.get('stream')); } if (url.searchParams.has('stream_invite')) { await open(); await inspectInvitation(url.searchParams.get('stream_invite')); } }).catch(error);
        return ready;
    }
    global.StreamingConsole = { init, open, minimize, isOpen, ownsHistory: () => isOpen() || Boolean(dialog), notification, compose, request, inspectInvitation, whenReady: () => ready };
})(window);
