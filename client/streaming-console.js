(function (global) {
    'use strict';
    const t = value => global.TunnelI18n?.t(value) || value;
    const uid = () => {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
        return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
    };
    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const userText = value => '<span class="message-content">' + esc(value) + '</span>';
    const kindOf = file => {
        const type = String(file.type || '').split(';')[0].trim().toLowerCase();
        if (type === 'application/x-drop2tunnel-rich') return 'rich';
        if (type && !['application/octet-stream', 'binary/octet-stream'].includes(type)) {
            if (/^image\//.test(type) && type !== 'image/svg+xml') return 'image';
            if (/^video\//.test(type)) return 'video';
            if (/^audio\//.test(type)) return 'audio';
            if (/^(text\/markdown|text\/x-markdown)$/.test(type)) return 'markdown';
            if (type === 'text/plain') return /\.(md|markdown)$/i.test(file.name) ? 'markdown' : 'text';
            return '';
        }
        return /^video\//.test(file.type) || /\.(mp4|webm|mkv|mov|m4v)$/i.test(file.name) ? 'video'
        : /^audio\//.test(file.type) || /\.(mp3|m4a|ogg|opus|wav|flac|aac)$/i.test(file.name) ? 'audio'
            : /^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.name) ? 'image'
                : /\.(md|markdown)$/i.test(file.name) ? 'markdown' : /\.txt$/i.test(file.name) || file.type === 'text/plain' ? 'text' : '';
    };
    const labelKind = kind => t(({ local: '本机文件', disk: '网盘文件', tunnel: '隧道文件', video: '视频', audio: '音频', image: '图片', markdown: 'Markdown', rich: '富文本', text: 'TXT' })[kind] || kind);
    const stateLabel = value => t(({ public: '公开', invite: '仅限邀请', offline: '下线', restricted: '访问已结束', playing: '正在播放', stopped: '已停止', paused: '已暂停', waiting: '等待播放', reading: '正在展示', buffering: '缓冲中', blocked: '浏览器限制播放，请点击开始观看', error: '播放失败，请重试', generated: '已生成', sent: '已发送', delivered: '已发送', accepted: '已接受', rejected: '已拒绝', expired: '已到期', revoked: '已撤销' })[value] || value);
    let config, root, main, banner, initialized = false, ready, currentAccount = '', currentUser, renderVersion = 0, syncFlight, visibilityUnsubscribe, visibilitySyncTimer;
    let stopWatchSchedule = () => {};
    let ui = { view: 'discover', stationId: '', scroll: {}, drafts: {} }, pending = new Map(), channel = 'local', candidates = [], pickerVersion = 0;
    let diskScope = { accountId: '', diskSpace: '', path: '', mountId: '' }, tunnelScope = '', importBusy = false, lastList = [], dialog, discoveryTimes = {};
    const localFiles = new Map(), players = new Map(), noticeIds = new Map();
    const pendingCovers = new Map();
    let pendingEditorFocus = null;
    const durationJobs = new Map(), durationQueue = [], previewTickets = new Map(); let durationActive = 0, refreshEditorItems, candidateObservers = [];
    const key = name => 'streaming:' + config.deviceId() + ':' + name;
    const account = () => global.DiskClient?.getAccount() || '';
    function saveUi() { if (!config) return; try { ui.importState = { pending: [...pending], channel, diskScope, tunnelScope }; localStorage.setItem(key('ui'), JSON.stringify(ui)); } catch (_) { notice('本机配置保存失败，请检查浏览器存储空间'); } }
    function saveConfig(stationId, value) { localStorage.setItem(key('station:' + stationId), JSON.stringify(value)); }
    function localConfig(stationId) { try { return JSON.parse(localStorage.getItem(key('station:' + stationId)) || 'null'); } catch (_) { return null; } }
    function notice(text, code = '') { if (banner) { banner.textContent = t(text) + (code ? ' [' + code + ']' : ''); banner.dataset.errorCode = code; banner.hidden = false; } }
    function error(cause) {
        if (cause.message === 'STREAM_TUNNEL_CONTEXT_TIMEOUT') { notice('读取本机隧道授权超时，请检查浏览器存储后点击刷新；未确认当前是否有可见串流台。', cause.message); return; }
        if (cause.message === 'STREAM_CONTROL_TIMEOUT' || cause.message === 'Failed to fetch') { notice('串流状态读取失败，请检查连接后点击刷新；未确认当前是否有可见串流台。', cause.message); return; }
        if (cause.message === 'STREAM_SOURCE_CHANGED') { notice('来源内容已变更，请重新导入该节目项', cause.message); return; }
        if (cause.message === 'STREAM_MEDIA_DECODE_FAILED') { notice('浏览器无法解码该媒体，请检查格式与编码', cause.message); return; }
        if (cause.message === 'STREAM_MEDIA_NETWORK_FAILED') { notice('媒体连接中断，可重试读取或检查网络与来源', cause.message); return; }
        if (cause.message === 'STREAM_TYPE_UNSUPPORTED') { notice('来源文件不是支持的可预览类型，请重新选择', cause.message); return; }
        if (cause.message === 'STREAM_INVITE_INVALID') { notice('邀请不存在或已被删除，请索取新邀请', cause.message); return; }
        const messages = { LOGIN_REQUIRED: '此操作需要登录账号', STREAM_OWNER_REQUIRED: '请切换或登录台的归属账号后管理', STREAM_SOURCE_LOGIN_REQUIRED: '请在创建设备重新登录归属账号，之后手动上线', STREAM_LOCAL_ONLY: '此操作只能在创建设备执行', STREAM_CONFLICT: '状态已更新，本次操作未应用，请刷新后重试', STREAM_KICKED: '此设备已被踢出，请联系创建者重新允许', STREAM_INVITATION_REQUIRED: '此台需要有效观看许可，请接受新邀请', STREAM_OFFLINE: '串流台已下线', STREAM_START_INVALID: '播放起点超出可播范围，请检查节目参数', STREAM_DURATION_REQUIRED: '无法确定媒体时长，请预览并检查浏览器是否支持', STREAM_SOURCE_DELETED: '来源已删除，请移除或重新选择节目', STREAM_SOURCE_MISSING: '来源不可读取，请在供源设备重新选择文件', STREAM_PROVIDER_OFFLINE: '供源设备不在线或文件授权不可用', STREAM_DEVICE_DENIED: '设备身份校验失败，请检查本机存储与服务端记录', STREAM_INVITE_DEVICE: '这是发给其它设备的定向邀请', STREAM_INVITE_REVOKED: '邀请已撤销，请索取新邀请', STREAM_INVITE_EXPIRED: '邀请已到期，请索取新邀请', STREAM_MESSAGE_NOT_SAVED: '消息未保存，请检查隧道状态后重试' };
        notice(messages[cause.message] || '操作未完成，请检查状态后重试', cause.message);
    }
    function button(label, run, className = '') {
        const node = document.createElement('button'); node.type = 'button'; node.textContent = className.includes('message-content') ? label : t(label); node.className = className;
        node.onclick = async event => { event.stopPropagation(); if (node.disabled) return; node.disabled = true; try { await run(event); } catch (cause) { error(cause); } finally { node.disabled = false; } };
        return node;
    }
    async function request(url, method = 'GET', data, options = {}) {
        const bounded = url === '/sync' || method === 'GET' && url.startsWith('/stations?');
        const controller = bounded ? new AbortController() : null;
        const cancelled = () => controller?.abort();
        options.signal?.addEventListener('abort', cancelled, {once:true});
        const deadline = controller ? setTimeout(cancelled, 20000) : null;
        try {
        const headers = { ...options.headers, 'X-Stream-Device': config.deviceId(), 'X-Stream-Key': localStorage.getItem(key('key')),
            ...(options.accountId ?? account() ? { 'X-Disk-Account': options.accountId ?? account() } : {}) };
        const binary = typeof Blob !== 'undefined' && data instanceof Blob;
        if (data !== undefined) headers['Content-Type'] = binary ? 'image/png' : 'application/json';
        if (options.onProgress) headers.Accept = 'application/x-ndjson';
        const response = await fetch('/api/streaming' + url, { method, headers, body: data === undefined ? undefined : binary ? data : JSON.stringify(data), cache: 'no-store', signal: controller?.signal || options.signal, keepalive: options.keepalive === true });
        if (response.ok && options.onProgress && response.headers.get('Content-Type')?.includes('application/x-ndjson')) {
            const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', result, finished = false;
            const consume = line => { if (!line.trim()) return; const value = JSON.parse(line); if (value.error) throw Object.assign(Error(value.error), value, { confirmedFailure: true }); if (value.progress) options.onProgress(value.progress); if (value.result) { result = value.result; finished = true; } };
            try { while (true) { const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true }); let end; while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); } } buffer += decoder.decode(); if (buffer.trim()) consume(buffer); }
            finally { reader.cancel().catch(() => {}); }
            if (!finished) throw Error('STREAM_SAVE_UNCONFIRMED'); return result;
        }
        const result = await response.json(); if (!response.ok) { const cause = Object.assign(Error(result.error || 'STREAM_REQUEST_FAILED'), result); cause.confirmedFailure = true; cause.retryAfter = Number(response.headers?.get('Retry-After')) || 0; throw cause; } return result;
        } catch (cause) { if (controller?.signal.aborted && !options.signal?.aborted) throw Error('STREAM_CONTROL_TIMEOUT'); throw cause; }
        finally { if(deadline!==null)clearTimeout(deadline); options.signal?.removeEventListener('abort',cancelled); }
    }
    async function copyText(value) {
        if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
        const input = document.createElement('textarea'); input.value = value; document.body.append(input); input.select();
        try { if (!document.execCommand('copy')) throw Error('STREAM_COPY_FAILED'); } finally { input.remove(); }
    }
    function follow(stationId, accountId, receive, failure) {
        const controller = new AbortController(); let retry = 2000;
        (async () => {
            while (!controller.signal.aborted) {
                try {
                    const response = await fetch('/api/streaming/stations/' + stationId + '/events', { headers: {
                        'X-Stream-Device': config.deviceId(), 'X-Stream-Key': localStorage.getItem(key('key')), ...(accountId ? { 'X-Disk-Account': accountId } : {})
                    }, cache: 'no-store', signal: controller.signal });
                    if (!response.ok) { const cause = Error((await response.json()).error || 'STREAM_CONNECTION_FAILED'); cause.retryAfter = Number(response.headers.get('Retry-After')) || 0; throw cause; }
                    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
                    try {
                        while (!controller.signal.aborted) {
                            const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
                            let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const record = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); if (record.error) throw Error(record.error); if (record.station) { receive(record.station); retry = 2000; } }
                        }
                    } finally { reader.cancel().catch(() => {}); }
                } catch (cause) {
                    if (!controller.signal.aborted) failure(cause);
                    if (['STREAM_KICKED', 'STREAM_INVITATION_REQUIRED', 'STREAM_OFFLINE', 'STREAM_NOT_FOUND', 'STREAM_DEVICE_DENIED'].includes(cause.message)) return;
                    retry = Math.max(retry, (cause.retryAfter || 0) * 1000);
                }
                if (!controller.signal.aborted) await new Promise(resolve => { const timer = setTimeout(done, retry); function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); } controller.signal.addEventListener('abort', done, { once: true }); });
                retry = Math.min(30000, retry * 2);
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
        const handle = saved?.handle || await handleStore('get', source.fileId).catch(() => null);
        if (handle && await handle.queryPermission({ mode: 'read' }) === 'granted') {
            const file = await handle.getFile();
            if (file.name !== source.name || file.size !== source.size) throw Error('missing');
            localFiles.set(source.fileId, { handle, file }); return file;
        }
        if (!handle && saved?.file) return saved.file;
        throw Error('missing');
    }
    async function providerLoop() {
        let retry = 1000; const providerId = uid();
        while (initialized) {
            try {
                // LAN HTTP/1 shares a small connection pool across tabs. Idle
                // supply polling must yield it to account/discovery requests.
                const work = await request('/provider-work', 'GET', undefined, { headers: { 'X-Stream-Provider': providerId, 'X-Stream-Wait': '1000' } });
                retry = 1000;
                await Promise.all((work.requests || []).map(async task => {
                    let blob, failure;
                    try { blob = task.source.kind === 'local' ? (await localBlob(task.source)).slice(task.start, task.end + 1) : await config.readTunnel(task.source, { start: task.start, end: task.end }); }
                    catch (cause) { failure = cause.message === 'missing' ? 'missing' : 'unavailable'; }
                    const headers = { 'X-Stream-Device': config.deviceId(), 'X-Stream-Key': localStorage.getItem(key('key')), 'Content-Type': 'application/octet-stream' };
                    if (failure) headers['X-Stream-Error'] = failure;
                    await fetch('/api/streaming/provider-work/' + task.requestId, { method: 'POST', headers, body: failure ? new Uint8Array() : blob }).catch(() => {});
                }));
                if (!work.requests?.length) await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (cause) { await new Promise(resolve => setTimeout(resolve, Math.max(retry, (cause.retryAfter || 0) * 1000))); retry = Math.min(30000, retry * 2); }
        }
    }
    async function sync(force = false) {
        if (syncFlight) { await syncFlight; if (force === true) return sync(); return; }
        if (!initialized) return;
        const selected = account(); syncFlight = syncNow(selected);
        try { await syncFlight; }
        finally { syncFlight = null; if (selected !== account()) queueMicrotask(() => sync()); }
    }
    async function syncNow(selected) {
        let contextDeadline;
        try {
            // The HTTP timeout cannot cover the local IndexedDB lookup that
            // precedes it. Release syncFlight on that failure too, so refresh
            // remains usable and late results cannot submit stale context.
            const tunnels = await Promise.race([config.tunnels(), new Promise((_resolve, reject) => { contextDeadline = setTimeout(() => reject(Error('STREAM_TUNNEL_CONTEXT_TIMEOUT')), 10000); })]);
            clearTimeout(contextDeadline);
            const state = await request('/sync', 'POST', { follows: config.devices().filter(item => item.followed).map(item => item.deviceId), tunnels }, { accountId: selected });
            if (selected !== account()) return;
            const changed = currentAccount !== selected || currentUser?.id !== state.identity?.id;
            currentAccount = selected; currentUser = state.identity;
            if (root) root.querySelector('[data-sc-account]').textContent = state.identity ? state.identity.name || state.identity.username || state.identity.id : t('登录 / 移除账号');
            for (const invite of state.invitations || []) {
                if (noticeIds.get(invite.id) === invite.status) continue;
                global.NotificationCenter?.add({ id: 'stream:' + invite.id, type: 'stream-invitation', title: t('串流邀请'),
                    body: invite.stationName + ' · ' + invite.deviceName + ' · ' + stateLabel(invite.status), createdAt: invite.createdAt,
                    resolved: ['accepted', 'rejected', 'expired', 'revoked'].includes(invite.status) ? invite.status : '', data: invite });
                noticeIds.set(invite.id, invite.status);
            }
            if (changed && isOpen()) await render();
            else if (isOpen() && ['discover', 'local', 'bookmarks', 'creator'].includes(ui.view)) await refreshList();
        } catch (cause) { if (selected === account() && isOpen()) error(cause); }
        finally { clearTimeout(contextDeadline); }
    }
    function ensureUi() {
        if (root) return;
        root = document.createElement('section'); root.id = 'streamingConsole'; root.className = 'sc-overlay'; root.hidden = true;
        root.setAttribute('aria-label', t('串流控制台'));
        root.innerHTML = '<header class="sc-header"><strong>串流控制台</strong><button type="button" data-sc-account></button><span class="sc-running"></span><button type="button" data-sc-minimize>_</button><button type="button" data-sc-home class="sc-close">×</button></header><div class="sc-workspace"><nav class="sc-nav"></nav><main class="sc-main"><div class="sc-banner" role="status" hidden></div><div class="sc-page"></div></main></div>';
        document.body.append(root); main = root.querySelector('.sc-page'); banner = root.querySelector('.sc-banner');
        root.querySelector('[data-sc-home]').onclick = () => closeConsole();
        root.querySelector('[data-sc-home]').setAttribute('aria-label', t('关闭串流控制台'));
        root.querySelector('[data-sc-minimize]').setAttribute('aria-label', t('最小化'));
        root.querySelector('[data-sc-minimize]').onclick = () => minimize();
        root.querySelector('[data-sc-account]').onclick = () => accountDialog();
        const nav = root.querySelector('.sc-nav');
        for (const [view, label] of [['discover', '发现'], ['local', '我创建的'], ['bookmarks', '我订阅的'], ['invitation', '通过邀请进入']]) {
            const b = button(label, () => navigate(view)); b.dataset.scView = view; nav.append(b);
        }
        nav.append(button('+ 创建', createStation, 'sc-primary'));
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
        clearWatchSchedule();
        root.hidden = true; saveUi(); global.dispatchEvent(new Event('streaming-visibility-change'));
        if (!fromHistory && history.state?.streamingConsole) { const next = { ...history.state }; delete next.streamingConsole; history.replaceState(next, '', location.href); }
    }
    function dirty() {
        const d = ui.drafts[ui.stationId], saved = localConfig(ui.stationId);
        const comparable = value => JSON.stringify(value && { name: value.name, coverId:value.coverId || '', coverPending:value.coverPending || '', loop: value.loop, countdown: value.countdown,
            items: value.items.map(({ sourceSaved, durationError, ...item }) => item) });
        return Boolean(['edit', 'import'].includes(ui.view) && d && comparable(d) !== comparable(saved));
    }
    function confirmLeave(leave) {
        const body = document.createElement('div'), status = document.createElement('p'); status.textContent = t('有尚未保存的更改，请保存后离开或放弃更改。'); body.append(status);
        const stationId = ui.stationId;
        if (saveFlights.has(stationId)) { status.textContent = t('正在保存节目单，请等待完成后再离开'); body.append(button('继续编辑', closeDialog)); showDialog('尚未保存', body); return; }
        body.append(button('保存后离开', async () => {
            try { if (!await persistDraft(stationId, value => { status.textContent = value; })) return; closeDialog(); leave(); }
            catch (cause) { status.textContent = t('节目单未保存，请检查来源后重试') + ' [' + cause.message + ']'; }
        }, 'sc-primary'), button('放弃更改', () => { delete ui.drafts[stationId]; discardCover(stationId); pending.clear(); saveUi(); closeDialog(); leave(); }), button('继续编辑', closeDialog));
        showDialog('尚未保存', body);
    }
    function closeConsole(force = false) {
        if (!force && dirty()) { confirmLeave(() => closeConsole(true)); return; }
        closeDialog(); pendingEditorFocus = null; for (const player of players.values()) player.close(); players.clear();
        minimize(); ++renderVersion; ++pickerVersion; candidateObservers.forEach(observer => observer.disconnect()); candidateObservers = [];
        ui = { view: 'discover', stationId: '', scroll: {}, drafts: {} }; pending.clear(); channel = 'local'; candidates = [];
        for (const stationId of pendingCovers.keys()) discardCover(stationId);
        diskScope = { accountId: '', diskSpace: '', path: '', mountId: '' }; tunnelScope = '';
        localStorage.removeItem(key('ui')); if (main) main.replaceChildren();
        const entry = document.getElementById('topbarStreamingBtn'); if (entry) entry.hidden = true;
    }
    function navigate(view, stationId = '', force = false, originList) {
        if (!force && dirty() && !(stationId === ui.stationId && ['edit', 'import'].includes(view))) { confirmLeave(() => navigate(view, stationId, true, originList)); return; }
        for (const [key, player] of players) if (!['watch', 'control'].includes(view) || key !== stationId + ':' + account()) { player.close(); players.delete(key); }
        if (stationId && stationId !== ui.stationId) ui.returnList = ['discover', 'local', 'bookmarks'].includes(ui.view) ? ui.view : 'discover';
        if (originList) ui.returnList = originList;
        ui.view = view; ui.stationId = stationId; saveUi(); render();
    }
    function returnToList() { navigate(['discover', 'local', 'bookmarks'].includes(ui.returnList) ? ui.returnList : 'discover'); }
    function coverUrl(s) { return s.coverId ? '/api/streaming/stations/' + encodeURIComponent(s.id) + '/covers/' + s.coverId + '?device=' + encodeURIComponent(config.deviceId()) + '&account=' + encodeURIComponent(account()) : ''; }
    function discardCover(stationId) { const cover = pendingCovers.get(stationId); if (cover) URL.revokeObjectURL(cover.url); pendingCovers.delete(stationId); }
    function coverImage(s,className) {
        const image=document.createElement('img'); image.className='sc-cover '+className; image.alt=t('串流台封面');image.loading='lazy';
        image.src=coverUrl(s)||'/client/icons/streaming.png';image.onerror=()=>{image.onerror=null;image.src='/client/icons/streaming.png';};return image;
    }
    function coverEditor(form,d,stationId) {
        const field=document.createElement('div');field.className='sc-cover-field';
        const label=document.createElement('label');label.textContent=t('封面');
        const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg,image/webp';input.setAttribute('aria-label',t('上传封面'));
        const preview=coverImage({id:stationId,coverId:d.coverId},'sc-cover-preview');if(pendingCovers.has(stationId))preview.src=pendingCovers.get(stationId).url;
        const status=document.createElement('small');status.setAttribute('role','status');let version=0;
        input.onchange=async()=>{
            const file=input.files?.[0],revision=++version;if(!file)return;status.textContent=t('正在裁剪封面…');
            try {
                if(!/^image\/(png|jpeg|webp)$/.test(file.type)||file.size>20*1024*1024)throw Error('STREAM_COVER_INVALID');
                const url=URL.createObjectURL(file),image=new Image();
                try {
                    // Use load/error as readiness signals. A decode() rejection
                    // alone does not prove that the selected file is unreadable.
                    await new Promise((resolve,reject)=>{
                        const finish=cause=>{clearTimeout(timer);image.onload=image.onerror=null;cause?reject(cause):resolve();};
                        const timer=setTimeout(()=>finish(Error('STREAM_COVER_DECODE_TIMEOUT')),15000);
                        image.onload=()=>finish();image.onerror=()=>finish(Error('STREAM_COVER_DECODE_FAILED'));image.src=url;
                    });
                    const side=Math.min(image.naturalWidth,image.naturalHeight);if(!side||image.naturalWidth*image.naturalHeight>40000000)throw Error('STREAM_COVER_INVALID');
                    const canvas=document.createElement('canvas');canvas.width=canvas.height=512;canvas.getContext('2d').drawImage(image,(image.naturalWidth-side)/2,(image.naturalHeight-side)/2,side,side,0,0,512,512);
                    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('STREAM_COVER_INVALID');
                    if(revision!==version || ui.stationId!==stationId || !field.isConnected)return;
                    const previous=pendingCovers.get(stationId);if(previous)URL.revokeObjectURL(previous.url);
                    const cover={blob,url:URL.createObjectURL(blob),token:uid()};pendingCovers.set(stationId,cover);d.coverPending=cover.token;preview.src=cover.url;saveUi();status.textContent=t('封面已裁剪为正方形，点击保存后生效');
                } finally {URL.revokeObjectURL(url);}
            }catch(cause){if(revision===version&&ui.stationId===stationId&&field.isConnected)status.textContent=t('封面处理失败，请选择有效图片')+' ['+cause.message+']';}
        };
        label.append(input);field.append(label,preview,status,button('移除封面',()=>{version++;const previous=pendingCovers.get(stationId);if(previous)URL.revokeObjectURL(previous.url);pendingCovers.delete(stationId);d.coverId='';delete d.coverPending;preview.src='/client/icons/streaming.png';saveUi();}));
        form.children[0].after(field);
        const expand=button('展开基本信息',()=>{form.classList.add('sc-basic-expanded');main.classList.add('sc-basic-open');});expand.className='sc-expand-basic';
        const collapse=button('收起',()=>{form.classList.remove('sc-basic-expanded');main.classList.remove('sc-basic-open');});collapse.className='sc-collapse-basic';form.prepend(expand);form.append(collapse);
    }
    function title(text) { const heading = document.createElement('h1'); heading.textContent = t(text); main.append(heading); return heading; }
    function parkPlayers() { const parking = document.getElementById('streamingParking'); for (const player of players.values()) parking.append(player.element); }
    async function render() {
        if (!isOpen()) return; const version = ++renderVersion;
        clearWatchSchedule();
        for (const [key, player] of players) if (!['watch', 'control'].includes(ui.view) || key !== ui.stationId + ':' + account()) { player.close(); players.delete(key); }
        parkPlayers(); main.replaceChildren(); main.classList.remove('sc-import-page', 'sc-editor-page', 'sc-viewer-page','sc-has-cover','sc-basic-open'); banner.hidden = true;
        candidateObservers.forEach(observer => observer.disconnect()); candidateObservers = []; pickerVersion++;
        root.querySelectorAll('[data-sc-view]').forEach(node => node.classList.toggle('selected', node.dataset.scView === ui.view));
        try {
            if (['discover', 'local', 'bookmarks', 'creator'].includes(ui.view)) {
                const heading = title(({ discover: '发现', local: '我创建的', bookmarks: '我订阅的', creator: '创作者公开台' })[ui.view]);
                heading.className = 'sc-list-heading'; const tools = document.createElement('span'); tools.className = 'sc-list-tools';
                if (ui.view !== 'creator') {
                    const label = document.createElement('label'), selector = document.createElement('select'); label.className = 'sc-list-sort'; label.append(document.createTextNode(t('排序')));
                    const choices = { local: [['updatedAt', '修改时间'], ['createdAt', '创建时间'], ['name', '名称']], bookmarks: [['subscribedAt', '订阅时间'], ['name', '名称']], discover: [['discoveredAt', '发现时间'], ['createdAt', '创建时间'], ['updatedAt', '修改时间'], ['name', '名称']] }[ui.view];
                    for (const [value, text] of choices) selector.add(new Option(t(text), value));
                    ui.sort ||= {}; selector.value = ui.sort[ui.view] || choices[0][0]; selector.onchange = () => { ui.sort[ui.view] = selector.value; saveUi(); refreshList().catch(error); }; label.append(selector); tools.append(label);
                }
                tools.append(button('刷新', async () => { await sync(true); })); heading.append(tools); await refreshList(version);
            }
            else if (ui.view === 'edit') { await reconcileRevision(ui.stationId); if (version === renderVersion) editor(); }
            else if (ui.view === 'import') await importer();
            else if (['watch', 'control'].includes(ui.view)) await watcher(version);
            else if (ui.view === 'access') await accessPage(version);
            else if (ui.view === 'blacklist') await blacklistPage(version);
            else if (ui.view === 'invitation') invitationPage();
            if (version !== renderVersion) return;
            root.querySelector('.sc-main').scrollTop = ui.scroll[ui.view + ':' + ui.stationId] || 0;
            global.TunnelI18n?.translate(root);
        } catch (cause) { if (version === renderVersion) error(cause); }
    }
    async function accountDialog(force = false) {
        if (force !== true && dirty()) { confirmLeave(() => accountDialog(true)); return; }
        await global.DiskUI.manageAccounts(); await sync(true);
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
        dialog.previewCleanup?.();
        dialog.querySelectorAll('video,audio').forEach(media => { media.pause(); media.removeAttribute('src'); }); dialog.remove(); dialog = null;
        if (!keepHistory && history.state?.streamingDialog) { const next = { ...history.state }; delete next.streamingDialog; history.replaceState(next, '', location.href); }
    }
    let listRequest = 0;
    async function refreshList(version = renderVersion) {
        const revision = ++listRequest;
        const view = ui.view, selected = account();
        const loading = document.createElement('p'); loading.className = 'sc-list-loading'; loading.setAttribute('role','status'); loading.textContent = t('正在读取串流台列表…'); main.append(loading);
        try {
            const result = await request('/stations?kind=' + (view === 'creator' ? 'creator&ownerId=' + encodeURIComponent(ui.stationId) : view));
            if (revision !== listRequest || version !== renderVersion || view !== ui.view || selected !== account()) return;
            if (view === 'discover') { let changed = false; for (const station of result.stations) { const identity = (currentUser?.id || selected) + ':' + station.id; if (!discoveryTimes[identity]) { discoveryTimes[identity] = Date.now(); changed = true; } } if (changed) try { localStorage.setItem(key('discoveries'), JSON.stringify(discoveryTimes)); } catch (_) { notice('本机配置保存失败，请检查浏览器存储空间'); } }
            const sort = ui.sort?.[view] || ({ local: 'updatedAt', bookmarks: 'subscribedAt', discover: 'discoveredAt' })[view];
            result.stations.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : (sort === 'discoveredAt' ? (discoveryTimes[(currentUser?.id || selected) + ':' + b.id] || 0) - (discoveryTimes[(currentUser?.id || selected) + ':' + a.id] || 0) : (b[sort] || 0) - (a[sort] || 0)));
            if (view === 'creator') { const heading = main.querySelector('h1'); if (heading) { const tools = heading.querySelector('.sc-list-tools'), title = document.createElement('span'), name = document.createElement('span'); title.className = 'sc-list-title'; name.className = 'message-content'; name.textContent = result.stations[0]?.owner?.name || ui.creatorName || ui.stationId; title.append(name, document.createTextNode(' ' + t('的公开台'))); heading.replaceChildren(title); if (tools) heading.append(tools); } }
            lastList = result.stations; let list = main.querySelector('.sc-station-list');
            if (!list) { list = document.createElement('div'); list.className = 'sc-station-list'; main.append(list); }
            list.replaceChildren();
            if (!result.stations.length) { const p = document.createElement('p'); p.textContent = t(view === 'bookmarks' ? '暂无已订阅的串流台' : '暂无可见串流台'); list.append(p); }
            const own = s => Boolean((currentUser?.id || selected) && s.ownerId === (currentUser?.id || selected));
            if (view === 'local' && (currentUser?.id || selected) && !result.stations.some(own)) { const empty = document.createElement('p'); empty.textContent = t('该账号尚未在本机创建串流台。'); list.append(empty); }
            const stations = view === 'local' ? [...result.stations.filter(own), ...result.stations.filter(s => !own(s))] : result.stations;
            let group;
            for (const s of stations) {
                if (view === 'local' && group !== own(s)) {
                    if (group !== undefined) list.append(document.createElement('hr'));
                    group = own(s); const heading = document.createElement('h2'); heading.textContent = t(group ? '当前账号创建的串流台' : '本机其它串流台'); list.append(heading);
                }
                const row = document.createElement('article'); row.className = 'sc-station-row'; row.dataset.stationId = s.id;
                row.innerHTML = `<div class="sc-device"><div>${userText(s.deviceName)}<small>${t('来源设备')}</small></div></div><div class="sc-number"><small>${t('台号')}</small>${userText(s.number)}</div><div class="sc-station-title"><strong>${userText(s.name)}</strong><small>${s.owner ? t('归属用户') + ' · ' + userText(s.owner.name) : t('无归属')}</small></div><div><small>${t('文件节目单')}</small>${s.itemCount}</div><div><small>${t('可见性')}</small>${stateLabel(s.visibility)}</div><div><small>${t('全局状态')}</small>${stateLabel(s.playback.status)}${s.locked ? '<small>' + t('需要源设备登录') + '</small>' : ''}</div>`;
                row.children[3].classList.add('sc-row-count');row.children[4].classList.add('sc-row-visibility');row.children[5].classList.add('sc-row-playback');
                row.prepend(coverImage(s, 'sc-list-cover'));
                const actions = document.createElement('div'); actions.className = 'sc-row-actions';
                if (own(s) && !s.local) { const origin = document.createElement('small'); origin.className = 'sc-own-remote message-content'; origin.textContent = t('由你在其它设备创建') + ' · ' + t('设备 ID') + ' ' + s.deviceId; row.querySelector('.sc-station-title').append(origin); }
                actions.append(button(s.visibility === 'offline' ? '查看状态' : '打开观看', () => navigate('watch', s.id), 'sc-primary'));
                if (view === 'discover') {
                    const subscription = button(s.subscribed ? '退订' : '订阅', async () => {
                        const result = await request('/stations/' + s.id + '/bookmark', s.subscribed ? 'DELETE' : 'PUT', undefined, { accountId: selected });
                        if (selected !== account() || revision !== listRequest || version !== renderVersion) return;
                        s.subscribed = result.subscribed; subscription.textContent = t(result.subscribed ? '退订' : '订阅');
                        notice(result.subscribed ? '已订阅' : '已取消订阅');
                    });
                    actions.append(subscription);
                }
                if (s.manageable) actions.append(button('操控串流台', () => navigate('control', s.id)));
                if (view === 'local') {
                    actions.append(button(s.manageable ? '编辑节目单' : '切换归属账号', () => s.manageable ? navigate('edit', s.id) : accountDialog()));
                    if (own(s) || !s.ownerId) actions.append(button('邀请与可见性', () => s.manageable ? navigate('access', s.id) : accountDialog()), button('观看者黑名单', () => s.manageable ? navigate('blacklist', s.id) : accountDialog()));
                    if (!s.ownerId && currentUser) actions.append(button('认领', async () => { await request('/stations/' + s.id + '/ownership', 'POST', { action: 'claim' }); await sync(); }));
                    if (s.manageable || s.locked) actions.append(button('删除台', async () => { if (!confirm(t('删除台及其配置，保留原始来源文件？'))) return; await request('/stations/' + s.id, 'DELETE'); localStorage.removeItem(key('station:' + s.id)); delete ui.drafts[s.id]; saveUi(); for (const [k, p] of players) if (k.startsWith(s.id + ':')) { p.close(); players.delete(k); } await refreshList(); }));
                } else if (view === 'bookmarks') actions.append(button('取消订阅', async () => { await request('/stations/' + s.id + '/bookmark', 'DELETE'); await refreshList(); }));
                if (s.owner) actions.append(button('创作者主页', () => { ui.creatorName = s.owner.name; navigate('creator', s.owner.id); }));
                row.append(actions); list.append(row);
            }
        } catch (cause) { if (revision === listRequest && version === renderVersion && selected === account()) throw cause; }
        finally { loading.remove(); }
    }
    async function createStation(force = false) {
        if (force !== true && dirty()) { confirmLeave(() => createStation(true)); return; }
        const creationId = localStorage.getItem(key('creating')) || uid(); localStorage.setItem(key('creating'), creationId);
        const s = await request('/stations', 'POST', { name: t('新串流台'), creationId });
        if (!localConfig(s.id)) saveConfig(s.id, { name: s.name, configVersion: s.configVersion, items: [], loop: true, countdown: 'bottom-right' });
        localStorage.removeItem(key('creating')); navigate('edit', s.id);
    }
    function draft() {
        if (!ui.drafts[ui.stationId]) { const saved = localConfig(ui.stationId); if (!saved) throw Error('STREAM_LOCAL_CONFIG_MISSING'); ui.drafts[ui.stationId] = saved; }
        return ui.drafts[ui.stationId];
    }
    const saveFlights = new Map();
    async function reconcileRevision(stationId) {
        const base = localConfig(stationId), actor = account(); if (!base) return;
        const baseline = { name: base.name, coverId:base.coverId || '', loop: base.loop, countdown: base.countdown, items: base.items.map(item => ({
            ...Object.fromEntries(['id','name','kind','size','type','duration','start','stay'].map(key => [key, item[key]])),
            source: Object.fromEntries(['kind','fileId','accountId','userId','diskSpace','sessionId','messageId'].map(key => [key, item.source?.[key]]))
        })) };
        const revision = await request('/stations/' + stationId + '/revision', 'POST', baseline, { accountId: actor });
        if (actor !== account()) return;
        if (revision.matches && revision.configVersion !== base.configVersion) {
            const oldVersion = base.configVersion; base.configVersion = revision.configVersion; saveConfig(stationId, base);
            if (ui.drafts[stationId]?.configVersion === oldVersion) ui.drafts[stationId].configVersion = revision.configVersion;
            saveUi();
        }
    }
    function saveFailure(cause) {
        if (cause.message === 'STREAM_COVER_RESELECT') return t('封面临时文件已不可用，请重新选择封面后保存');
        return cause.message === 'STREAM_CONFLICT' ? t('服务端节目单版本已变更，本机草稿已保留，请核对后重试') + ' · ' + (cause.expectedVersion ?? '?') + ' → ' + (cause.currentVersion ?? '?') + ' [STREAM_CONFLICT]'
            : t(!cause.confirmedFailure ? '保存结果尚未确认，请重新读取串流台状态' : '节目单未保存，请检查来源后重试') + ' [' + cause.message + ']';
    }
    async function persistDraft(stationId, saving) {
        if (saveFlights.has(stationId)) return saveFlights.get(stationId);
        const d = ui.drafts[stationId] || localConfig(stationId), actor = account();
        const unchecked = d.items.filter(item => ['video', 'audio'].includes(item.kind) && !item.duration);
        if (unchecked.length) { saving(t('尚未保存：媒体时长检查未完成') + '\n' + unchecked.map(item => item.name).join('\n')); return false; }
        const fingerprint = JSON.stringify({ ...d, configVersion: 0 }), submitted = structuredClone(d), coverToken = d.coverPending;
        const payload = { ...submitted, items: submitted.items.map(item => { const value = { ...item }; if (value.sourceSaved) delete value.source; delete value.sourceSaved; delete value.durationError; return value; }) };
        const flight = (async () => {
            saving(t('正在保存节目单…'));
            if (submitted.coverPending) {
                const cover = pendingCovers.get(stationId);
                if (!cover || cover.token !== submitted.coverPending) throw Error('STREAM_COVER_RESELECT');
                saving(t('正在保存封面…'));
                const uploaded = await request('/stations/' + stationId + '/cover','POST',cover.blob,{accountId:actor});
                payload.coverId=submitted.coverId=uploaded.coverId; delete payload.coverPending; delete submitted.coverPending;
            }
            await reconcileRevision(stationId); payload.configVersion = d.configVersion; submitted.configVersion = d.configVersion;
            const result = await request('/stations/' + stationId, 'PUT', payload, { accountId: actor, onProgress: value => saving(t(value.phase === 'persisting' ? '正在写入节目单…' : '正在校验节目来源…') + ' ' + value.completed + ' / ' + value.total + (value.name ? '\n' + value.name : '')) });
            submitted.configVersion = result.configVersion; submitted.items.forEach(item => { item.sourceSaved = true; }); saveConfig(stationId, submitted);
            const unchanged = ui.drafts[stationId] === d && JSON.stringify({ ...d, configVersion: 0 }) === fingerprint;
            if (ui.drafts[stationId] === d && coverToken && d.coverPending === coverToken && pendingCovers.get(stationId)?.token === coverToken) {
                d.coverId=submitted.coverId; delete d.coverPending;
                URL.revokeObjectURL(pendingCovers.get(stationId).url); pendingCovers.delete(stationId);
            }
            if (unchanged) delete ui.drafts[stationId];
            else if (ui.drafts[stationId] === d) { d.configVersion = result.configVersion; for (const item of d.items) if (submitted.items.some(saved => saved.id === item.id && JSON.stringify(saved.source) === JSON.stringify(item.source))) item.sourceSaved = true; }
            saveUi(); return unchanged;
        })();
        saveFlights.set(stationId, flight); try { return await flight; } finally { if (saveFlights.get(stationId) === flight) saveFlights.delete(stationId); }
    }
    function editor() {
        title('创建与编辑串流台'); main.classList.add('sc-editor-page'); const d = draft(), stationId = ui.stationId, actions = document.createElement('div'); actions.className = 'sc-actions sc-editor-actions';
        let saveBlocked = false;
        const layout = document.createElement('div'); layout.className = 'sc-editor-grid'; const form = document.createElement('section'); form.className = 'sc-card';
        form.innerHTML = `<label>${t('串流台名称')}<input class="sc-name" maxlength="120" value="${esc(d.name)}"></label><label>${t('播放结束')}<select class="sc-loop"><option value="loop">${t('循环节目单')}</option><option value="stop">${t('播完停止')}</option></select></label><label>${t('静态项倒计时')}<select class="sc-countdown-choice">${['top-left', 'top-right', 'bottom-left', 'bottom-right', 'edge'].map((value, i) => '<option value="' + value + '">' + t(['左上', '右上', '左下', '右下', '边缘薄进度条'][i]) + '</option>').join('')}</select></label><p>${t('导入仅保存来源引用，不复制或保护原文件')}</p>`;
        form.querySelector('.sc-loop').value = d.loop ? 'loop' : 'stop'; form.querySelector('.sc-countdown-choice').value = d.countdown;
        form.oninput = () => { d.name = form.querySelector('.sc-name').value; d.loop = form.querySelector('.sc-loop').value === 'loop'; d.countdown = form.querySelector('.sc-countdown-choice').value; saveUi(); };
        coverEditor(form,d,stationId);
        const resources = document.createElement('section'); resources.className = 'sc-card sc-editor-resources';
        const heading = document.createElement('h2'); heading.textContent = t('已导入节目项'); const resourceHeading = document.createElement('div'); resourceHeading.className = 'sc-editor-heading'; resourceHeading.append(heading, button('导入', () => { pending = new Map(); channel = 'local'; candidates = []; navigate('import', ui.stationId); })); resources.append(resourceHeading);
        const list = document.createElement('div'); list.className = 'sc-program-list'; resources.append(list);
        function focusProgram(id, duration = 1000, highlightIds = [id]) {
            const target = [...list.children].find(node => node.dataset.itemId === id); if (!target) return;
            target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            for (const row of list.children) if (highlightIds.includes(row.dataset.itemId)) {
                row.style.setProperty('--sc-focus-duration', duration + 'ms'); row.classList.add('sc-record-focus'); setTimeout(() => row.classList.remove('sc-record-focus'), duration);
            }
        }
        function renderItems() {
            list.replaceChildren();
            d.items.forEach((item, index) => {
                const row = document.createElement('article'); row.className = 'sc-program'; row.dataset.itemId = item.id;
                const av = ['video', 'audio'].includes(item.kind);
                row.innerHTML = `<div class="sc-program-name"><strong>${index + 1}. ${userText(item.name)}</strong><small>${labelKind(item.source?.kind)} · ${labelKind(item.kind)} · ${formatSize(item.size)}</small></div><label>${t(av ? '起始时刻（秒）' : '停留时间（秒）')}<input type="number" min="${av ? 0 : .1}" step="0.1" value="${av ? item.start || 0 : item.stay || 10}" aria-label="${t(av ? '起始时刻（秒）' : '停留时间（秒）')}"></label>`;
                row.querySelector('input').oninput = event => { item[av ? 'start' : 'stay'] = Number(event.target.value); saveUi(); };
                if (av) {
                    const state = document.createElement('p'); state.className = 'sc-duration-status'; state.setAttribute('role', 'status'); state.hidden = Boolean(item.duration);
                    state.textContent = t(item.durationError ? '时长检查失败，请重试或重新选择来源' : '正在后台检查媒体时长…') + (item.durationError ? ' [' + item.durationError + ']' : '');
                    const retry = button('重试时长检查', () => { durationJobs.delete(account() + ':' + durationKey(item)); ensureDuration(item); refreshEditorItems?.(); }, 'sc-duration-retry'); retry.hidden = !item.durationError;
                    row.append(state, retry);
                }
                const toolbar = document.createElement('div'); toolbar.className = 'sc-actions';
                const moveTo = (to, duration) => { const from = d.items.indexOf(item); d.items.splice(from, 1); d.items.splice(Math.min(d.items.length, Math.max(0, to)), 0, item); saveUi(); renderItems(); focusProgram(item.id, duration); };
                const move = delta => moveTo(d.items.indexOf(item) + delta, 250);
                const handle = button('拖动排序', () => {}); handle.className = 'sc-drag-handle';
                let start = null;
                handle.onpointerdown = event => { start = { y: event.clientY }; handle.setPointerCapture(event.pointerId); event.preventDefault(); };
                handle.onpointermove = event => { if (!start || Math.abs(event.clientY - start.y) < 8) return; const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.sc-program'); list.querySelectorAll('.sc-drop-target').forEach(node => node.classList.remove('sc-drop-target')); target?.classList.add('sc-drop-target'); };
                handle.onpointerup = event => { if (!start) return; start = null; const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.sc-program'); const to = d.items.findIndex(value => value.id === target?.dataset.itemId); if (to >= 0) { const from = d.items.indexOf(item); d.items.splice(from, 1); d.items.splice(to, 0, item); saveUi(); renderItems(); } };
                handle.onpointercancel = () => { start = null; list.querySelectorAll('.sc-drop-target').forEach(node => node.classList.remove('sc-drop-target')); };
                toolbar.append(handle, button('置顶', () => moveTo(0, 1000)), button('置底', () => moveTo(d.items.length - 1, 1000)), button('↑', () => move(-1)), button('↓', () => move(1)), button('预览', () => preview(item)), button('重复加入', () => { const added = { ...structuredClone(item), id: uid(), sourceSaved: false }; d.items.splice(d.items.indexOf(item) + 1, 0, added); ensureDuration(added); saveUi(); renderItems(); focusProgram(added.id); }), button('移除', () => { d.items = d.items.filter(value => value.id !== item.id); saveUi(); renderItems(); }));
                if (item.source?.kind === 'local') toolbar.append(button('重新选择文件', () => chooseLocalFile(item)));
                row.append(toolbar); list.append(row);
            });
        }
        refreshEditorItems = () => {
            if (ui.view !== 'edit' || ui.stationId !== stationId || !list.isConnected) return;
            const items = new Map(d.items.map(item => [item.id, item]));
            for (const row of list.children) { const item = items.get(row.dataset.itemId), state = row.querySelector('.sc-duration-status'), retry = row.querySelector('.sc-duration-retry');
                if (!item || !state) continue; state.hidden = Boolean(item.duration); state.textContent = t(item.durationError ? '时长检查失败，请重试或重新选择来源' : '正在后台检查媒体时长…') + (item.durationError ? ' [' + item.durationError + ']' : ''); retry.hidden = !item.durationError;
            }
            if (saveBlocked) showDurationBlock();
        };
        for (const item of d.items) if (!item.durationError) ensureDuration(item);
        renderItems(); layout.append(form, resources); main.append(layout);
        const saveStatus = document.createElement('p'); saveStatus.className = 'sc-save-status'; saveStatus.setAttribute('role', 'status'); saveStatus.hidden = true;
        const saving = text => { saveStatus.hidden = false; saveStatus.textContent = text; };
        function showDurationBlock() {
            const unchecked = d.items.filter(item => ['video', 'audio'].includes(item.kind) && !item.duration);
            saving(unchecked.length ? t('尚未保存：媒体时长检查未完成') + ' · ' + unchecked.length + '\n' + unchecked.map(item => item.name + ' · ' + t(item.durationError ? '时长检查失败，请重试或重新选择来源' : '正在后台检查媒体时长…') + (item.durationError ? ' [' + item.durationError + ']' : '')).join('\n') : t('媒体时长检查已完成，可以保存节目单'));
        }
        actions.append(button('保存', async () => {
            const unchecked = d.items.filter(item => ['video', 'audio'].includes(item.kind) && !item.duration);
            if (unchecked.length) { saveBlocked = true; showDurationBlock(); return; } saveBlocked = false;
            const stationId = ui.stationId, actor = account(); actions.setAttribute('aria-busy', 'true'); let unchanged;
            try { unchanged = await persistDraft(stationId, saving); }
            catch (cause) { saving(saveFailure(cause)); if (cause.message !== 'STREAM_CONFLICT') throw cause; return; }
            finally { actions.removeAttribute('aria-busy'); }
            if (ui.stationId === stationId && account() === actor) { if (unchanged) navigate('control', stationId); notice(unchanged ? '串流台已保存' : '串流台已保存，期间的新编辑仍保留在草稿'); }
        }, 'sc-primary'), button('返回列表', returnToList)); main.append(saveStatus, actions);
        if (pendingEditorFocus?.stationId === stationId) {
            const focus = pendingEditorFocus; pendingEditorFocus = null;
            // Run after render() restores the page's saved scroll position.
            requestAnimationFrame(() => { if (ui.view === 'edit' && ui.stationId === stationId && list.isConnected) focusProgram(focus.ids[0],1000,focus.ids); });
        }
    }
    async function chooseLocalFile(replace) {
        const remember = async (files, handles = []) => {
            for (let index = 0; index < files.length; index++) {
                const file = files[index], kind = kindOf(file); if (!kind) { notice('已忽略不支持的文件类型'); continue; }
                if (replace && (file.name !== replace.name || file.size !== replace.size)) throw Error('STREAM_FILE_MISMATCH');
                const fileId = replace?.source.fileId || uid(), source = { kind: 'local', fileId, name: file.name, type: file.type, size: file.size };
                localFiles.set(fileId, { file, handle: handles[index] });
                if (replace) { replace.sourceSaved = false; delete replace.duration; replace.durationError = ''; durationJobs.delete(account() + ':' + durationKey(replace)); ensureDuration(replace); }
                if (handles[index]) await handleStore('put', fileId, handles[index]).catch(() => notice('文件引用仅在本次页面会话有效，重开后请重新选择'));
                else notice('文件引用仅在本次页面会话有效，重开后请重新选择');
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
        main.classList.add('sc-import-page');
        candidateObservers.forEach(observer => observer.disconnect()); candidateObservers = [];
        const channels = document.createElement('div'); channels.className = 'sc-tabs';
        for (const value of ['local', 'disk', 'tunnel']) channels.append(button(labelKind(value), () => { channel = value; candidates = value === 'local' ? [...pending.values()].filter(item => item.source.kind === 'local') : []; saveUi(); importer(); }, channel === value ? 'selected' : ''));
        main.append(channels); const controls = document.createElement('div'); controls.className = 'sc-source-controls'; const list = document.createElement('div'); list.className = 'sc-candidate-list'; const actions = document.createElement('div'); actions.className = 'sc-actions sc-import-actions';
        main.append(controls, list, actions);
        function showSelected() {
            const overlay = document.createElement('section'); overlay.className = 'sc-selected-overlay'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', t('已选择的资源'));
            const tabs = document.createElement('div'), content = document.createElement('div'), footer = document.createElement('footer'); tabs.className = 'sc-tabs'; content.className = 'sc-selected-list';
            const close = () => overlay.remove(); footer.append(button('收起', close)); overlay.append(tabs, content, footer); main.append(overlay);
            const render = kind => {
                content.replaceChildren(); for (const tab of tabs.children) tab.classList.toggle('selected', tab.dataset.kind === kind);
                const selected = [...pending.values()].filter(item => item.source.kind === kind);
                if (!selected.length) { const empty = document.createElement('p'); empty.textContent = t('此分类尚未选择文件'); content.append(empty); }
                for (const item of selected) { const row = document.createElement('article'); row.className = 'sc-selected-row message-content'; const name = document.createElement('strong'); name.textContent = item.name + ' · ' + formatSize(item.size); row.append(name);
                    if (item.location) { const path = document.createElement('p'); path.textContent = item.location; row.append(path); } content.append(row); }
            };
            for (const kind of ['local', 'disk', 'tunnel']) { const tab = button(labelKind(kind), () => render(kind)); tab.dataset.kind = kind; tabs.append(tab); }
            render(channel); footer.querySelector('button').focus();
        }
        function renderCandidates() {
            candidateObservers.forEach(observer => observer.disconnect()); candidateObservers = [];
            list.replaceChildren();
            for (const candidate of candidates) {
                const row = document.createElement('label'); row.className = 'sc-candidate';
                const check = document.createElement('input'); check.type = 'checkbox'; check.checked = pending.has(candidateKey(candidate));
                check.onchange = () => { if (check.checked) pending.set(candidateKey(candidate), candidate); else pending.delete(candidateKey(candidate)); saveUi(); count.textContent = t('已选择') + ' · ' + pending.size; };
                const text = document.createElement('span'); text.className = 'message-content'; text.textContent = candidate.name + ' · ' + labelKind(candidate.kind);
                row.dataset.recordId = candidate.source.messageId || '';
                const thumbnail = document.createElement('span'); thumbnail.className = 'sc-source-thumbnail'; thumbnail.textContent = ({ video: '▶', audio: '♪', image: '▧', markdown: 'MD', text: 'TXT' })[candidate.kind];
                if (candidate.thumbnailUrl || candidate.kind === 'image' && candidate.size <= 524288) {
                    const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy';
                    const observer = new IntersectionObserver(entries => { if (!entries.some(entry => entry.isIntersecting)) return; observer.disconnect();
                        if (!row.isConnected || version !== pickerVersion) return;
                        Promise.resolve(candidate.thumbnailUrl || sourceUrl(candidate)).then(url => { if (row.isConnected && version === pickerVersion) { image.src = url; thumbnail.replaceChildren(image); } }).catch(() => {});
                    }); observer.observe(row); candidateObservers.push(observer);
                }
                text.textContent += ' · ' + formatSize(candidate.size);
                row.append(check, thumbnail, text, button('预览', event => { event.preventDefault(); return preview(candidate); })); list.append(row);
            }
        }
        const count = button(t('已选择') + ' · ' + pending.size, showSelected); actions.append(count);
        actions.append(button('确认导入', async () => {
            if (importBusy) return; importBusy = true; const d = draft(), stationId = ui.stationId, actor = account();
            try {
                if (d.items.length + pending.size > 500) { notice('节目单最多包含 500 项，请减少选择后重试'); return; }
                notice('正在登记资源引用…');
                channels.inert = controls.inert = list.inert = true;
                const selection = [...pending.values()];
                const additions = [], grants = await config.tunnels();
                for (const candidate of selection) {
                    const item = structuredClone(candidate); item.id = uid(); item.stay = 10; item.start = 0;
                    item.source.tunnelGrants = Object.fromEntries(grants.map(entry => [entry.sessionId, entry.accessGrant])); additions.push(item);
                }
                if (version !== pickerVersion || ui.stationId !== stationId || ui.view !== 'import' || account() !== actor) return;
                d.items.push(...additions); pending.clear(); saveUi(); navigate('edit', stationId);
            } finally { importBusy = false; channels.inert = controls.inert = list.inert = false; }
        }, 'sc-primary'), button('取消', () => { pending.clear(); navigate('edit', ui.stationId); }));
        if (channel === 'local') { controls.append(button('选择本机文件', () => chooseLocalFile())); renderCandidates(); return; }
        const loading = document.createElement('p'); loading.className = 'sc-import-loading'; loading.setAttribute('role', 'status'); loading.textContent = t('正在加载资源列表…'); list.append(loading); list.setAttribute('aria-busy', 'true');
        try {
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
            const breadcrumb = document.createElement('nav'); breadcrumb.className = 'sc-import-path'; breadcrumb.setAttribute('aria-label', t('当前路径'));
            const go = path => { diskScope.path = path; importer().catch(error); };
            breadcrumb.append(button('/', () => go(''))); const parts = diskScope.path.split('/').filter(Boolean);
            parts.forEach((name, index) => breadcrumb.append(button(name, () => go(parts.slice(0, index + 1).join('/')), 'message-content')));
            breadcrumb.append(button('上级目录', () => { if (!diskScope.path) diskScope.mountId = ''; go(parts.slice(0, -1).join('/')); }, 'sc-up')); controls.append(breadcrumb);
            const folders = document.createElement('div'); folders.className = 'sc-import-folders'; controls.append(folders);
            for (const folder of result.folders || []) folders.append(button('▱ ' + folder.name + ' · ' + (Number.isFinite(folder.fileCount) ? folder.fileCount : '?') + ' ' + t('个文件'), () => go(folder.path), 'message-content'));
            for (const mount of result.mounts || []) folders.append(button('▱ ' + mount.name, () => { diskScope.mountId = mount.id; go(''); }, 'message-content'));
            candidates = (result.files || []).filter(file => kindOf(file)).map(file => ({ name: file.name, type: file.type, size: file.size, kind: kindOf(file),
                location: selector.selectedOptions[0]?.textContent + ' → ' + partition.selectedOptions[0]?.textContent + ' → /' + diskScope.path,
                thumbnailUrl: file.thumbnailAvailable ? context.requestBase + '/files/' + encodeURIComponent(file.id) + '/thumbnail?disk_space=' + encodeURIComponent(context.diskSpace) + '&disk_account=' + encodeURIComponent(context.accountId) : '',
                source: { kind: 'disk', accountId: diskScope.accountId, diskSpace: diskScope.diskSpace, fileId: file.id } }));
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
            const recordList = document.createElement('div'); recordList.className = 'sc-import-records'; controls.append(recordList);
            for (const recordId of records) recordList.append(button(t('选择记录') + ' ' + recordId.slice(-6), () => {
                for (const item of candidates.filter(item => item.source.messageId === recordId)) pending.set(candidateKey(item), item);
                saveUi(); count.textContent = t('已选择') + ' · ' + pending.size; renderCandidates();
                const rows = [...list.children].filter(row => row.dataset.recordId === recordId); rows[0]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                rows.forEach(row => { row.classList.add('sc-record-focus'); setTimeout(() => row.classList.remove('sc-record-focus'), 1200); });
            }, 'message-content'));
        }
        const randomCount = document.createElement('input'); randomCount.type = 'number'; randomCount.min = 1; randomCount.max = candidates.length; randomCount.value = Math.min(3, candidates.length); randomCount.setAttribute('aria-label', t('随机导入数量'));
        const random = document.createElement('div'); random.className = 'sc-import-random';
        main.insertBefore(random, channel === 'tunnel' ? list : actions);
        random.append(randomCount, button('从当前范围随机选取', () => {
            const amount = Number(randomCount.value); if (!Number.isInteger(amount) || amount < 1 || amount > candidates.length) throw Error('STREAM_PARAMETER_INVALID');
            const pool = candidates.slice(); for (let index = pool.length - 1; index > 0; index--) { const other = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1); [pool[index], pool[other]] = [pool[other], pool[index]]; }
            for (const candidate of pool.slice(0, amount)) pending.set(candidateKey(candidate), candidate); saveUi(); count.textContent = t('已选择') + ' · ' + pending.size; renderCandidates();
        }));
        renderCandidates();
        } catch (cause) { if (version === pickerVersion) { loading.textContent = t('资源列表加载失败，请重试') + ' [' + cause.message + ']'; loading.classList.add('sc-load-failed'); list.append(button('重试', () => importer())); } }
        finally { if (version === pickerVersion) { list.removeAttribute('aria-busy'); if (!loading.classList.contains('sc-load-failed')) loading.remove(); } }
    }
    function formatSize(size) { if (!Number.isFinite(Number(size))) return t('大小未知'); const n = Number(size); return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
    const durationKey = item => candidateKey(item) + ':' + item.size + ':' + item.name;
    function ensureDuration(item) {
        if (!['video', 'audio'].includes(item.kind) || item.duration) return;
        const identity = durationKey(item), jobKey = account() + ':' + identity; let job = durationJobs.get(jobKey);
        if (!job) {
            let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
            job = { item: structuredClone(item), actor: account(), promise, resolve, reject }; durationJobs.set(jobKey, job); durationQueue.push(job);
        }
        item.durationError = '';
        job.promise.then(value => { if (durationJobs.get(jobKey) === job && durationKey(item) === identity) { item.duration = value; item.durationError = ''; saveUi(); refreshEditorItems?.(); } }, cause => { if (durationJobs.get(jobKey) === job && durationKey(item) === identity) { item.durationError = cause.message; saveUi(); refreshEditorItems?.(); } });
        pumpDurations();
    }
    function pumpDurations() {
        while (durationActive < 2 && durationQueue.length) {
            const job = durationQueue.shift(); durationActive++;
            duration(job.item, job.actor).then(job.resolve, job.reject).finally(() => { durationActive--; pumpDurations(); });
        }
    }
    async function sourceUrl(item, signal, actor = account()) {
        const cacheKey = actor + ':' + durationKey(item), cached = previewTickets.get(cacheKey);
        if (cached?.expiresAt > Date.now() + 30000) return cached.url;
        const source = structuredClone(item.source); source.tunnelGrants = Object.fromEntries((await config.tunnels()).map(entry => [entry.sessionId, entry.accessGrant]));
        const ticket = await request('/preview', 'POST', { source }, { signal, accountId: actor }); previewTickets.set(cacheKey, ticket); return ticket.url;
    }
    async function duration(item, actor) {
        return new Promise((resolve, reject) => {
            const controller = new AbortController(); let media, local, url, done = false;
            const timer = setTimeout(() => finish(Error('STREAM_DURATION_REQUIRED')), 30000);
            function finish(cause) {
                if (done) return; done = true; clearTimeout(timer); controller.abort(); const value = media?.duration;
                if (cause) previewTickets.delete(actor + ':' + durationKey(item));
                if (media) { media.onloadedmetadata = media.onerror = null; media.removeAttribute('src'); media.load(); }
                if (local && url) URL.revokeObjectURL(url); cause ? reject(cause) : resolve(value);
            }
            (async () => {
                local = item.source.kind === 'local' ? await localBlob(item.source) : null; if (done) return;
                url = local ? URL.createObjectURL(local) : await sourceUrl(item, controller.signal, actor); if (done) { if (local) URL.revokeObjectURL(url); return; }
                media = document.createElement(item.kind); media.preload = 'metadata';
                media.onloadedmetadata = () => finish(Number.isFinite(media.duration) && media.duration > 0 ? null : Error('STREAM_DURATION_REQUIRED'));
                media.onerror = () => finish(Error('STREAM_MEDIA_METADATA_ERROR')); media.src = url;
            })().catch(finish);
        });
    }
    async function preview(item) {
        const body = document.createElement('div'), progress = document.createElement('p'); body.className = 'sc-preview'; progress.setAttribute('role', 'status'); progress.textContent = t('正在准备预览…'); body.append(progress);
        showDialog('资源预览', body); const current = dialog, controller = new AbortController(); let objectUrl;
        current.previewCleanup = () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
        try {
            const url = await sourceUrl(item, controller.signal); if (controller.signal.aborted) return;
            if (['video', 'audio'].includes(item.kind)) {
                const media = document.createElement(item.kind); media.controls = true; media.preload = 'metadata'; media.onloadedmetadata = () => { progress.textContent = t('预览已就绪'); }; media.onerror = () => { progress.textContent = t('媒体无法播放，可重新读取或检查源文件'); }; media.src = url; body.append(media); return;
            }
            const response = await fetch(url, { cache: 'no-store', signal: controller.signal }); if (!response.ok) throw Error('STREAM_SOURCE_UNAVAILABLE');
            const reader = response.body.getReader(), total = Number(response.headers.get('Content-Length')); let loaded = 0; const chunks = [];
            try { for (;;) { const part = await reader.read(); if (part.done) break; chunks.push(part.value); loaded += part.value.byteLength;
                if (loaded > (item.kind === 'image' ? 64 : 2) * 1048576) throw Error('STREAM_PREVIEW_TOO_LARGE');
                progress.textContent = (total > 0 ? Math.min(100, Math.floor(loaded / total * 100)) + '% · ' : t('已加载') + ' · ') + formatSize(loaded);
            } } finally { reader.cancel().catch(() => {}); }
            if (controller.signal.aborted) return;
            const blob = new Blob(chunks, { type: response.headers.get('Content-Type') || item.type });
            if (item.kind === 'image') {
                const image = document.createElement('img'); image.alt = item.name; objectUrl = URL.createObjectURL(blob);
                image.onload = () => { if (!controller.signal.aborted) progress.textContent = t('预览已就绪') + ' · ' + formatSize(loaded); };
                image.onerror = () => { if (!controller.signal.aborted) progress.textContent = t('图片无法读取，请检查来源'); };
                progress.textContent = t('图片已加载，正在解码…') + ' · ' + formatSize(loaded); image.src = objectUrl; body.append(image); return;
            }
            else if (item.kind === 'rich') {
                const html = await blob.text(), node = document.createElement('div'), mapping = new Map(), references = [];
                node.className = 'sc-document message-content';
                for (const asset of new Set([...html.matchAll(/data-tunnel-asset-id=["']([\w.-]+)["']/g)].map(value => value[1]))) {
                    const source = {kind:'tunnel',sessionId:item.source.sessionId,messageId:'editor-assets',fileId:asset};
                    const ref = {url:'tunnel-blob:'+source.sessionId+'/editor-assets/'+asset}; references.push(ref);
                    try { mapping.set(ref.url,await sourceUrl({source},controller.signal)); } catch (cause) { if(controller.signal.aborted)throw cause; }
                }
                if (controller.signal.aborted) return;
                global.StreamingPlayer.renderRich(node, html, references, mapping); body.append(node);
            }
            else { const pre = document.createElement('pre'); pre.textContent = await blob.text(); body.append(pre); }
            progress.textContent = t('预览已就绪') + ' · ' + formatSize(loaded);
        } catch (cause) { if (!controller.signal.aborted) progress.textContent = t(cause.message === 'STREAM_PREVIEW_TOO_LARGE' ? '文件超出预览大小限制，请通过原来源查看' : '预览失败，请重试') + ' [' + cause.message + ']'; }
    }
    function programWaits(value, elapsed = 0) {
        const result = new Map(), currentId = value.playback?.itemId;
        const items = value.items || [], pending = items.filter(item => item.id !== currentId);
        const state = ['offline', 'restricted'].includes(value.visibility) ? value.visibility : value.locked ? 'locked' : value.playback?.status !== 'playing' ? value.playback?.status || 'stopped' : '';
        for (const item of pending) result.set(item.id, { state: item.unavailable ? 'unavailable' : state || 'unscheduled' });
        if (state) return result;
        const available = items.filter(item => !item.unavailable), currentIndex = available.findIndex(item => item.id === currentId);
        if (currentIndex < 0) return result;
        const length = item => {
            const seconds = ['video', 'audio'].includes(item.kind) ? Number(item.duration) - Number(item.start || 0) : Number(item.stay);
            return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
        };
        let wait = length(available[currentIndex]);
        if (wait !== null) wait -= Math.max(0, Number(value.playback.position) || 0) + Math.max(0, elapsed);
        const ordered = [...available.slice(currentIndex + 1), ...(value.loop ? available.slice(0, currentIndex) : [])];
        for (const item of ordered) {
            result.set(item.id, wait === null ? { state: 'duration' } : wait <= 0 ? { state: 'syncing' } : { state: 'scheduled', seconds: wait });
            const seconds = length(item); wait = wait === null || seconds === null ? null : wait + seconds;
        }
        if (!value.loop) for (const item of available.slice(0, currentIndex)) result.set(item.id, { state: 'finished' });
        return result;
    }
    function programWaitText(wait) {
        if (wait.state !== 'scheduled') return t(({ offline: '串流台已下线', restricted: '访问已结束', locked: '需要源设备登录', paused: '全台已暂停', stopped: '等待全台播放', unavailable: '来源不可用', duration: '等待时长确认', syncing: '正在同步放送状态', finished: '本轮已放送', unscheduled: '暂无放送安排' })[wait.state] || '暂无放送安排');
        const seconds = Math.ceil(wait.seconds);
        if (wait.seconds < 60) return t('{0}秒后放送').replace('{0}', seconds);
        const minutes = Math.floor(seconds / 60);
        return minutes < 60 ? t('{0}分后放送').replace('{0}', minutes) : t('{0}小时{1}分后放送').replace('{0}', Math.floor(minutes / 60)).replace('{1}', minutes % 60);
    }
    function clearWatchSchedule() { stopWatchSchedule(); stopWatchSchedule = () => {}; }
    function watchSchedule(rows, state, active) {
        let timer;
        const update = () => {
            if (!active()) { clearInterval(timer); return; }
            const waits = programWaits(state.value, Math.max(0, performance.now() - state.receivedAt) / 1000);
            for (const [id, node] of rows) node.textContent = programWaitText(waits.get(id) || { state: 'unscheduled' });
        };
        timer = setInterval(update, 1000); update();
        return () => clearInterval(timer);
    }
    async function watcher(version) {
        const requestedAccount = account(), get = url => request(url, 'GET', undefined, { accountId: requestedAccount });
        const controlling = ui.view === 'control', heading = title(controlling ? '操控串流台' : '观看串流台');
        const s = lastList.find(item => item.id === ui.stationId);
        let snapshot;
        try {
            if (s?.manageable || s?.local || !s) {
                try { snapshot = await get('/stations/' + ui.stationId + '?manage=1'); }
                catch (cause) { if (cause.message !== 'STREAM_OWNER_REQUIRED') throw cause; snapshot = await get('/stations/' + ui.stationId); }
            } else snapshot = await get('/stations/' + ui.stationId);
        }
        catch (cause) { if (s?.visibility === 'offline') { offlinePage(s); return; } throw cause; }
        if (version !== renderVersion || requestedAccount !== account()) return;
        if (controlling && !snapshot.manageable) throw Error('STREAM_OWNER_REQUIRED');
        if (!controlling) {
            main.classList.add('sc-viewer-page'); heading.textContent = t('串流台') + ' · ' + snapshot.number + ' · ' + snapshot.name;
            heading.classList.add('message-content');
        }
        const info = document.createElement('div'); info.className = 'sc-watch-info'; info.innerHTML = `<strong>${userText(snapshot.number + ' · ' + snapshot.name)}</strong><p>${t('来源设备')} · ${userText(snapshot.deviceName)}${snapshot.owner ? ' · ' + t(snapshot.owner.id === currentUser?.id ? '创建者为自己' : '归属用户') + ' · ' + userText(snapshot.owner.name) : ' · ' + t('无归属')}</p>`;
        if (!controlling) {
            info.replaceChildren(document.createTextNode(t('来源') + ' · ' + snapshot.deviceName + ' · '));
            if (snapshot.owner) {
                const creator = document.createElement('a'); creator.href = '#'; creator.className = 'message-content'; creator.textContent = snapshot.owner.name;
                creator.onclick = event => { event.preventDefault(); ui.creatorName = snapshot.owner.name; navigate('creator', snapshot.owner.id); }; info.append(creator);
            } else info.append(document.createTextNode(t('无归属')));
        }
        main.append(info); const layout = document.createElement('div'); layout.className = 'sc-watch-grid'; const stage = document.createElement('div'); const aside = document.createElement('aside'); aside.className = 'sc-card'; layout.append(stage, aside); main.append(layout);
        if (!controlling) { main.insertBefore(coverImage(snapshot,'sc-viewer-cover'),layout);heading.prepend(coverImage(snapshot,'sc-viewer-cover-small')); }
        const actions = document.createElement('div'); actions.className = 'sc-actions'; main.append(actions);
        const fixedAccount = account();
        const subscribedLabel = controlling ? '已订阅' : '退订';
        const subscription = button(snapshot.subscribed ? subscribedLabel : '订阅', async () => {
            const result = await request('/stations/' + snapshot.id + '/bookmark', snapshot.subscribed ? 'DELETE' : 'PUT', undefined, { accountId: fixedAccount });
            if (fixedAccount !== account()) return;
            snapshot.subscribed = result.subscribed; subscription.textContent = t(result.subscribed ? subscribedLabel : '订阅'); notice(result.subscribed ? '已订阅' : '已取消订阅');
        });
        actions.append(subscription, button(controlling ? '复制观看链接' : '复制链接', async () => { await copyText(location.origin + '/?stream=' + snapshot.id); notice('观看链接已复制'); }), button('返回列表', returnToList));
        if (controlling && snapshot.owner) actions.append(button('创作者主页', () => { ui.creatorName = snapshot.owner.name; navigate('creator', snapshot.owner.id); }));
        if (!controlling) { main.insertBefore(actions, info); if (snapshot.manageable) actions.append(button('操控串流台', () => navigate('control', snapshot.id))); }
        const playerKey = snapshot.id + ':' + account(); let player = players.get(playerKey);
        const waitRows = new Map(), scheduleState = { value: snapshot, receivedAt: performance.now() };
        const fillInfo = value => {
            if (!['watch', 'control'].includes(ui.view) || ui.stationId !== value.id || version !== renderVersion) return;
            snapshot = value; scheduleState.value = value; scheduleState.receivedAt = performance.now(); waitRows.clear(); subscription.textContent = t(value.subscribed ? subscribedLabel : '订阅');
            aside.replaceChildren(); const heading = document.createElement('h2'); heading.textContent = controlling ? t('全局状态') + ' · ' + stateLabel(['offline', 'restricted'].includes(value.visibility) ? value.visibility : value.playback.status) : t('节目单'); aside.append(heading);
            if (!controlling && value.visibility === 'offline') { const state = document.createElement('p'); state.textContent = t('串流台已下线'); stage.replaceChildren(state); }
            const waits = programWaits(value);
            for (const item of value.items) {
                const row = document.createElement('p'); row.className = 'sc-watch-item';
                if (controlling && value.manageable) row.append(button('切换节目', () => command('select', { itemId: item.id })));
                row.classList.toggle('sc-now-playing', item.id === value.playback.itemId);
                const name = document.createElement('span'); name.className = 'message-content';
                name.textContent = (item.id === value.playback.itemId ? '▶ ' : '') + (({ disk: '▤', tunnel: '⇄', local: '🗃️' })[item.sourceKind] || '') + ' ' + item.name + (item.unavailable ? ' · ' + t('来源不可用') : '');
                if (item.id !== value.playback.itemId) { const wait = document.createElement('small'); wait.className = 'sc-program-wait'; wait.textContent = programWaitText(waits.get(item.id)); waitRows.set(item.id, wait); name.append(wait); }
                row.append(name); aside.append(row);
            }
            if (controlling && value.manageable && value.viewers?.length) { const h = document.createElement('h3'); h.textContent = t('实际观看设备'); aside.append(h);
                for (const viewer of value.viewers) { const p = document.createElement('p'); p.className = 'message-content'; p.textContent = viewer.name + ' · ' + stateLabel(viewer.status) + ' · ' + viewer.position.toFixed(1) + 's'; if (viewer.deviceId !== value.deviceId) p.append(button('踢出', () => kick(value.id, viewer.deviceId))); aside.append(p); }
            }
        };
        async function command(action, extra = {}) {
            const latest = player?.snapshot() || snapshot;
            const result = await request('/stations/' + snapshot.id + '/control', 'POST', { action, version: latest.playback.version, ...extra }); player?.apply(result); fillInfo(result);
        }
        const seekControl = async (itemId, position) => { if (itemId !== (player?.snapshot() || snapshot).playback.itemId) await command('select', { itemId }); await command('seek', { position }); };
        if (snapshot.visibility !== 'offline') {
            if (!player) { player = global.StreamingPlayer.create({ stationId: snapshot.id, watchId: uid(),
                request: (url, method, data, options) => request(url, method, data, { ...options, accountId: fixedAccount }), subscribe: (receive, failure) => follow(snapshot.id, fixedAccount, receive, failure),
                onSeek: controlling ? seekControl : undefined,
                onState: value => { player.onView?.(value); }, onError: cause => { if (ui.stationId === snapshot.id && isOpen()) error(cause); },
                onRecovery: code => { if (ui.stationId === snapshot.id && banner?.dataset.errorCode === code) { banner.hidden = true; banner.textContent = ''; banner.dataset.errorCode = ''; } } }); players.set(playerKey, player); }
            player.onView = fillInfo; player.setController?.(controlling ? seekControl : undefined); stage.append(player.element); player.apply(snapshot);
            const fullscreen = player.element.querySelector('.sc-window-only'); if (fullscreen) fullscreen.textContent = t(controlling ? '媒体全屏' : '全屏');
        } else { fillInfo(snapshot); }
        stopWatchSchedule = watchSchedule(waitRows, scheduleState, () => isOpen() && ['watch','control'].includes(ui.view) && ui.stationId === snapshot.id && version === renderVersion);
        if (snapshot.visibility === 'offline' && snapshot.manageable && (!snapshot.ownerId && snapshot.local || snapshot.ownerId === currentUser?.id)) {
            const online = button('上线', () => navigate('access', snapshot.id), 'sc-online sc-primary'); main.prepend(online);
        }
        if (controlling && snapshot.manageable) {
            const globalControls = document.createElement('div'); globalControls.className = 'sc-global-controls'; const scope = document.createElement('strong'); scope.textContent = t('全台控制，影响所有跟随者'); globalControls.append(scope);
            for (const [action, label] of [['previous', '上一个'], ['play', '全台播放'], ['pause', '全台暂停'], ['next', '下一个'], ['stop', '全台停止'], ['retry', '重新校验来源']]) globalControls.append(button(label, () => command(action)));
            const seek = document.createElement('input'); seek.type = 'number'; seek.min = 0; seek.step = .1; seek.value = snapshot.playback.position.toFixed(1); seek.setAttribute('aria-label', t('全局节目进度（秒）'));
            globalControls.append(seek, button('调整全局进度', () => command('seek', { position: Number(seek.value) })), button('后退 10 秒', () => command('seek', { position: Math.max(0, (player?.snapshot() || snapshot).playback.position - 10) })), button('快进 10 秒', () => { const state = player?.snapshot() || snapshot, item = state.items.find(item => item.id === state.playback.itemId); return command('seek', { position: Math.min(item?.duration ? item.duration - item.start : item?.stay || 0, state.playback.position + 10) }); }));
            main.append(globalControls); actions.append(button('邀请与可见性', () => navigate('access', snapshot.id)));
            if (snapshot.local) actions.append(button('编辑节目单', () => navigate('edit', snapshot.id)));
        }
    }
    function offlinePage(s) {
        const p = document.createElement('h2'); p.textContent = t('全局状态') + ' · ' + t('下线'); main.append(p);
        if (s.manageable) main.append(button('邀请与可见性', () => navigate('access', s.id)));
        main.append(button('返回列表', returnToList));
    }
    async function kick(stationId, deviceId) { if (confirm(t('终止此设备的观看并阻止旧入口重新进入？'))) { await request('/stations/' + stationId + '/access', 'POST', { deviceId, allow: false }); notice('已终止该设备对本台的访问'); } }
    async function accessPage(version) {
        title('邀请与可见性'); const stationId = ui.stationId, s = await request('/stations/' + stationId + '?manage=1'); if (version !== renderVersion) return;
        const visibility = document.createElement('section'); visibility.className = 'sc-card'; const h = document.createElement('h2'); h.textContent = t('可见性'); visibility.append(h);
        for (const value of ['public', 'invite', 'offline']) visibility.append(button(stateLabel(value), async () => {
            const reset = value === 'invite' && (s.visibility === 'public' || s.visibility === 'offline');
            if (reset && !confirm(t('改为仅邀请会退出旧观看端、撤销旧观看资格及此前所有邀请，保留订阅。继续？'))) return;
            if (value === 'offline' && !confirm(t('下线将停止服务并保留订阅，继续？'))) return;
            const fresh = await request('/stations/' + stationId + '?manage=1'); await request('/stations/' + stationId + '/visibility', 'POST', { visibility: value, version: fresh.playback.version, confirmReset: reset }); render();
        }, s.visibility === value ? 'selected' : ''));
        if (s.local && s.ownerId) visibility.append(button('放弃归属', async () => { if (confirm(t('放弃台归属，保留普通观看许可和订阅？'))) { await request('/stations/' + stationId + '/ownership', 'POST', { action: 'release' }); navigate('local'); } }));
        main.append(visibility); const inviteForm = document.createElement('section'); inviteForm.className = 'sc-card';
        inviteForm.innerHTML = `<h2>${t('生成与发送邀请')}</h2><label>${t('有效期（小时，留空为不过期）')}<input class="sc-hours" type="number" min="0.017" step="1" value="24"></label><label><input type="checkbox" class="sc-thumbnail">${t('附带当前媒体缩略图（可用时）')}</label><div class="sc-device-choices"></div><div class="sc-actions"></div>`;
        const input = () => ({ hours: inviteForm.querySelector('.sc-hours').value === '' ? null : Number(inviteForm.querySelector('.sc-hours').value), thumbnail: inviteForm.querySelector('.sc-thumbnail').checked ? thumbnail(stationId) : null });
        let generalRequestId = uid();
        inviteForm.querySelector('.sc-actions').append(button('生成通用邀请', async () => { const result = await request('/stations/' + stationId + '/invitations', 'POST', { ...input(), requestId: generalRequestId }); generalRequestId = uid(); await showInvite(result); }), button('发送定向邀请', async () => {
            const actor = account(), settings = input(), body = document.createElement('div'), status = document.createElement('p');
            status.setAttribute('role', 'status'); status.textContent = t('正在读取可邀请设备…'); body.append(status); showDialog('选择邀请设备', body);
            const opened = dialog;
            let result;
            try { await sync(true); result = await request('/devices', 'GET', undefined, { accountId: actor }); }
            catch (cause) { status.textContent = t('设备列表读取失败，请关闭后重试') + ' [' + cause.message + ']'; return; }
            if (dialog !== opened || account() !== actor) return;
            if (!result.devices.length) { status.textContent = t('暂无可邀请的其它设备，可先连接或关注设备'); return; }
            status.textContent = t('已默认选择全部设备，包含已关注的离线设备');
            const choices = document.createElement('div'); choices.className = 'sc-device-choices'; const rows = [];
            for (const device of result.devices) {
                const row = document.createElement('label'), check = document.createElement('input'), name = document.createElement('span'), outcome = document.createElement('span');
                check.type = 'checkbox'; check.checked = true; name.className = 'message-content'; name.textContent = device.name || device.deviceId; outcome.setAttribute('role', 'status');
                row.append(check, name, outcome); choices.append(row); rows.push({ deviceId: device.deviceId, check, outcome, requestId: uid(), done: false });
            }
            const actions = document.createElement('div'); actions.className = 'sc-actions'; let sending = false;
            for (const [label, mode] of [['全选', 'all'], ['取消全选', 'none'], ['反选', 'invert']]) actions.append(button(label, () => { if (!sending) for (const row of rows) if (!row.done) row.check.checked = mode === 'all' || mode === 'invert' && !row.check.checked; }));
            actions.append(button('确认发送', async () => {
                if (sending) return;
                if (account() !== actor) { status.textContent = t('账号已切换，请关闭后重新选择邀请设备'); return; }
                const queue = rows.filter(row => row.check.checked && !row.done);
                if (!queue.length) { status.textContent = t('请选择邀请设备'); return; }
                sending = true; rows.forEach(row => { row.check.disabled = true; }); status.textContent = t('正在发送定向邀请…');
                let successes = 0, failures = 0;
                const send = async () => { while (queue.length) { const row = queue.shift(); row.outcome.textContent = t('发送中…');
                    try { await request('/stations/' + stationId + '/invitations', 'POST', { ...settings, deviceId: row.deviceId, requestId: row.requestId }, { accountId: actor }); row.done = true; row.check.checked = false; row.outcome.textContent = t('已发送'); successes++; }
                    catch (cause) { row.outcome.textContent = t('发送失败，可重试') + ' [' + cause.message + ']'; failures++; }
                } };
                try { await Promise.all([send(), send()]); }
                finally { sending = false; rows.forEach(row => { row.check.disabled = row.done; }); }
                status.textContent = t('发送成功') + ' · ' + successes + ' / ' + t('发送失败') + ' · ' + failures;
                if (version === renderVersion && account() === actor) await renderInvites();
            }, 'sc-primary')); body.append(actions, choices);
        })); main.append(inviteForm);
        const invitationList = document.createElement('section'); invitationList.className = 'sc-card'; main.append(invitationList);
        async function renderInvites() {
            const result = await request('/stations/' + stationId + '/invitations'); if (version !== renderVersion) return; invitationList.replaceChildren();
            for (const invite of result.invitations) { const row = document.createElement('div'); row.className = 'sc-invite-row'; const label = document.createElement('span'); label.className = 'message-content'; label.textContent = (invite.deviceId || t('通用邀请')) + ' · ' + stateLabel(invite.status) + ' · ' + (invite.expiresAt ? new Date(invite.expiresAt).toLocaleString() : t('不过期')); row.append(label, button('查看邀请', () => showInvite(invite)), button('撤销', async () => { await request('/stations/' + stationId + '/invitations/' + invite.id, 'DELETE'); await renderInvites(); })); invitationList.append(row); }
        }
        async function showInvite(invite) {
            const body = document.createElement('div'), input = document.createElement('textarea'); input.readOnly = true; input.value = location.origin + '/?stream_invite=' + invite.token; input.setAttribute('aria-label', t('邀请链接')); body.append(input);
            body.append(button('复制邀请链接', async () => { await copyText(input.value); notice('邀请链接已复制'); }), button('复制邀请码', async () => { await copyText(invite.token); notice('邀请码已复制'); }));
            if (!invite.deviceId) {
                const selector = document.createElement('select'), tunnels = await config.tunnels(); for (const entry of tunnels) selector.add(new Option([entry.shortCode, entry.remark].filter(Boolean).join(' · ') || entry.name || entry.sessionId, entry.sessionId));
                if (tunnels.some(entry => entry.sessionId === config.currentTunnel())) selector.value = config.currentTunnel();
                selector.setAttribute('aria-label', t('目标隧道')); body.append(selector);
                const submissionId = uid(); body.append(button('转发到隧道', async () => {
                    const selected = tunnels.find(entry => entry.sessionId === selector.value); if (!selected) throw Error('STREAM_TUNNEL_DENIED');
                    const sent = await request('/tunnel-markdown', 'POST', { ...selected, inviteToken: invite.token, messageId: submissionId, deviceName: config.deviceName() });
                    await config.onMessage?.(sent.message, selected.sessionId); notice('邀请消息已发送，接收者可自行接受'); closeDialog();
                }));
            }
            showDialog('邀请详情', body); await renderInvites();
        }
        await renderInvites();
        main.append(button('观看者黑名单', () => navigate('blacklist', stationId)), button('返回操控', () => navigate('control', stationId)));
    }
    async function blacklistPage(version) {
        title('观看者黑名单'); const stationId = ui.stationId, actor = account();
        const station = await request('/stations/' + stationId + '?manage=1', 'GET', undefined, { accountId: actor });
        if (version !== renderVersion || actor !== account()) return;
        const form = document.createElement('section'); form.className = 'sc-card';
        const kind = document.createElement('select'); kind.setAttribute('aria-label', t('黑名单类型')); kind.add(new Option(t('设备 ID'), 'device')); kind.add(new Option(t('用户账号 ID'), 'user'));
        const input = document.createElement('input'); input.setAttribute('aria-label', t('黑名单 ID')); input.maxLength = 128;
        form.append(kind, input, button('加入黑名单', async () => {
            const value = input.value.trim(); if (!value) { notice('请输入需要限制的 ID'); input.focus(); return; }
            await request('/stations/' + stationId + '/access', 'POST', { [kind.value === 'user' ? 'userId' : 'deviceId']: value, allow: false }, { accountId: actor });
            if (actor === account() && version === renderVersion) render();
        })); main.append(form);
        let count = 0;
        for (const [field, ids, label] of [['deviceId', station.blocked || [], '设备 ID'], ['userId', station.blockedUsers || [], '用户账号 ID']]) {
            const section = document.createElement('section'); section.className = 'sc-card'; const heading = document.createElement('h2'); heading.textContent = t(label); section.append(heading);
            for (const id of ids) { count++; const row = document.createElement('div'); row.className = 'sc-invite-row'; const text = document.createElement('span'); text.className = 'message-content'; text.textContent = id;
                row.append(text, button('解除限制', async () => { await request('/stations/' + stationId + '/access', 'POST', { [field]: id, allow: true }, { accountId: actor }); if (actor === account() && version === renderVersion) render(); })); section.append(row);
            } main.append(section);
        }
        if (!count) { const empty = document.createElement('p'); empty.textContent = t('本台暂无黑名单条目'); main.append(empty); }
        main.append(button('返回列表', returnToList));
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
        const token = String(value.includes('stream_invite=') ? new URL(value, location.origin).searchParams.get('stream_invite') || '' : value).trim();
        const response = await request('/invitations/' + encodeURIComponent(token), 'POST', { decision: 'accept' });
        closeDialog(); await open(); navigate('watch', response.stationId, false, 'discover'); await sync();
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
    async function openInvitation(token, { onOpen } = {}) {
        try { await open(); onOpen?.(); await inspectInvitation(token); return true; } catch (cause) { error(cause); return false; }
    }
    function canImportRecord(message) {
        if (['markdown','text','rich'].includes(message.type)) return Boolean(String(message.markdown || message.text || message.content || '').trim());
        return (message.type === 'file' ? [message.fileInfo] : message.collection?.files || []).some(file => file && kindOf(file));
    }
    async function importRecord(message, createNew=false, force=false) {
        await ready;
        if(!force&&dirty()){confirmLeave(()=>importRecord(message,createNew,true).catch(error));return;}
        const actor=account();
        const grants=await config.tunnels(),context=grants.find(entry=>entry.sessionId===(message.sessionId||config.currentTunnel()));
        if(!context)throw Error('STREAM_TUNNEL_DENIED');
        const result=await request('/tunnel-candidates','POST',{...context,messageId:message.id});
        if(!result.candidates.length){if(isOpen())notice('这条记录没有可导入的可视内容');else config.toast(t('这条记录没有可导入的可视内容'));return;}
        const prepare=stationId=>result.candidates.map(candidate=>{const item=structuredClone(candidate);item.id=uid();item.stay=10;item.start=0;item.source.tunnelGrants=Object.fromEntries(grants.map(entry=>[entry.sessionId,entry.accessGrant]));return item;});
        const enter=async(station,d,position,baseline)=>{
            if(actor!==account())throw Error('STREAM_OWNER_REQUIRED');
            const additions=prepare(station.id);if(d.items.length+additions.length>500)throw Error('STREAM_PLAYLIST_INVALID');
            if(baseline)saveConfig(station.id,baseline);
            d.items.splice(position,0,...additions);ui.drafts[station.id]=d;
            pendingEditorFocus={stationId:station.id,ids:additions.map(item=>item.id)};
            saveUi();closeDialog();await open();
            if(actor!==account())throw Error('STREAM_OWNER_REQUIRED');
            navigate('edit',station.id);
        };
        if(createNew){
            if(actor!==account())throw Error('STREAM_OWNER_REQUIRED');
            const station=await request('/stations','POST',{name:t('新串流台'),creationId:uid()},{accountId:actor});
            const d={name:station.name,configVersion:station.configVersion,items:[],loop:true,countdown:'bottom-right',coverId:''};saveConfig(station.id,d);return enter(station,d,0);
        }
        const stations=(await request('/stations?kind=local')).stations.filter(s=>s.local&&s.manageable);
        if(!stations.length){if(isOpen())notice('本设备没有当前身份可编辑的串流台');else config.toast(t('本设备没有当前身份可编辑的串流台'));return;}
        const body=document.createElement('div'),select=document.createElement('select'),items=document.createElement('select'),position=document.createElement('div'),status=document.createElement('p');
        body.className='sc-insert-dialog';position.className='sc-insert-position';status.className='sc-insert-status';status.setAttribute('role','status');
        select.setAttribute('aria-label',t('目标串流台'));items.setAttribute('aria-label',t('参照节目'));items.size=6;
        for(const s of stations)select.add(new Option(s.number+' · '+s.name,s.id));
        const before=document.createElement('input'),after=document.createElement('input');before.type=after.type='radio';before.name=after.name='sc-insert-position';after.checked=true;
        for(const [input,label] of [[before,'插入该节目之前'],[after,'插入该节目之后']]){const field=document.createElement('label');field.append(input,t(label));position.append(field);}
        const add=button('添加并编辑',()=>{if(!d)throw Error('STREAM_REQUEST_FAILED');const index=d.items.findIndex(item=>item.id===items.value);return enter(stations.find(s=>s.id===select.value),d,index<0?d.items.length:index+(after.checked?1:0),baseline);},'sc-primary');
        let d,baseline,revision=0;
        const comparable=value=>JSON.stringify(value&&{...value,configVersion:0,items:value.items.map(({sourceSaved,durationError,...item})=>item)});
        const reload=button('放弃旧草稿，读取最新节目单',()=>load(true));reload.hidden=true;
        const load=async(discard=false)=>{
            const ticket=++revision,id=select.value;d=null;baseline=null;add.disabled=true;reload.hidden=true;items.replaceChildren();status.textContent=t('正在读取节目单…');
            try {
                // Always read the authorized current baseline before adding.
                // A cached configuration can be older than the server even if
                // the user has not edited anything in this page.
                await reconcileRevision(id);
                const latest=await request('/stations/'+id+'/edit-config','GET',undefined,{accountId:actor});
                if(ticket!==revision||body.isConnected===false)return;if(actor!==account())throw Error('STREAM_OWNER_REQUIRED');
                const saved=localConfig(id),existing=ui.drafts[id];
                const modified=existing&&comparable(existing)!==comparable(saved);
                if(modified&&!discard&&existing.configVersion!==latest.configVersion){
                    status.textContent=t('服务端节目单已更新，本机未保存的草稿仍保留。可关闭此窗口继续编辑草稿，或放弃旧草稿后读取最新节目单。')+' · '+existing.configVersion+' → '+latest.configVersion;
                    reload.hidden=false;return;
                }
                const current=modified&&!discard?existing:latest;d=structuredClone(current);baseline=latest;
                // Merely opening/cancelling this picker must not change the
                // baseline underneath an already-rendered editor.
                if(discard){saveConfig(id,latest);delete ui.drafts[id];discardCover(id);saveUi();if(ui.view==='edit'&&ui.stationId===id)render();}
                for(const item of d.items)items.add(new Option(item.name,item.id));if(d.items.length)items.selectedIndex=0;
                status.textContent=d.items.length?t('选择参照节目及插入位置，添加后继续编辑。'):t('节目单为空，将插入开头');add.disabled=false;
            }catch(cause){if(ticket===revision&&body.isConnected!==false)status.textContent=t('节目单读取失败，请重新选择')+' ['+cause.message+']';}
        };
        const stationLabel=document.createElement('strong');stationLabel.textContent=t('目标串流台');
        const itemLabel=document.createElement('strong');itemLabel.textContent=t('参照节目');
        select.onchange=()=>load();body.append(stationLabel,select,status,itemLabel,items,position,add,reload);
        showDialog('添加到串流台',body);await load();
    }
    async function sendMarkdown(body, messageId = uid()) {
        await ready;
        const tunnels = await config.tunnels(), context = tunnels.find(entry => entry.sessionId === config.currentTunnel());
        if (!context) throw Error('STREAM_TUNNEL_DENIED');
        const sent = await request('/tunnel-markdown', 'POST', { ...context, body, messageId, deviceName: config.deviceName(), tunnelGrants: Object.fromEntries(tunnels.map(entry => [entry.sessionId, entry.accessGrant])) });
        await config.onMessage?.(sent.message, context.sessionId); config.toast(t('Markdown 消息已发送')); return sent;
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
        visibilityUnsubscribe?.(); clearTimeout(visibilitySyncTimer);
        const entryUrl = new URL(location.href);
        try { ui = { ...ui, ...JSON.parse(localStorage.getItem(key('ui')) || '{}') }; } catch (_) {}
        try { discoveryTimes = JSON.parse(localStorage.getItem(key('discoveries')) || '{}') || {}; } catch (_) {}
        if (ui.importState) { pending = new Map(ui.importState.pending || []); channel = ui.importState.channel || 'local'; diskScope = ui.importState.diskScope || diskScope; tunnelScope = ui.importState.tunnelScope || ''; candidates = [...pending.values()].filter(item => item.source.kind === channel); }
        ready = (async () => {
            let secret = localStorage.getItem(key('key')); if (!secret) { secret = uid().replace(/-/g, '') + uid().replace(/-/g, ''); localStorage.setItem(key('key'), secret); }
            const response = await fetch('/api/streaming/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: config.deviceId(), key: secret, name: config.deviceName() }) });
            if (!response.ok) throw Error('STREAM_DEVICE_DENIED');
            providerLoop(); await sync();
        })();
        ready.catch(cause => { initialized = false; config.toast(t('串流模块初始化失败') + ' [' + cause.message + ']'); });
        visibilityUnsubscribe = config.subscribeVisibilityChanges?.(() => {
            clearTimeout(visibilitySyncTimer);
            visibilitySyncTimer = setTimeout(() => { ready.then(() => sync(true)).catch(() => {}); }, 100);
        });
        document.getElementById('streamingConsoleBtn')?.addEventListener('click', () => { document.getElementById('connectionHeaderMenu').hidden = true; open().catch(error); });
        document.getElementById('topbarStreamingBtn')?.addEventListener('click', () => open().catch(error));
        document.getElementById('sendMarkdownBtn')?.addEventListener('click', () => compose().catch(error));
        global.addEventListener('focus', sync); global.addEventListener('global-account-changed', sync); setInterval(sync, 30000);
        global.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
        global.addEventListener('popstate', event => {
            const restore = () => { if (isOpen() && !history.state?.streamingConsole) history.pushState({ ...(history.state || {}), streamingConsole: true }, '', location.href); };
            if (dialog) { closeDialog(); restore(); return; }
            const fullscreen = document.querySelector('.sc-media-fullscreen');
            if (fullscreen) { for (const player of players.values()) if (player.element === fullscreen) player.exitFullscreen(); restore(); return; }
            if (!isOpen()) return;
            const parent = { import: 'edit', edit: ui.returnList || 'discover', access: 'control', blacklist: ui.returnList || 'discover', watch: ui.returnList || 'discover', control: ui.returnList || 'discover', creator: 'discover', invitation: 'discover' }[ui.view];
            if (parent) { navigate(parent, ['edit', 'watch', 'control'].includes(parent) ? ui.stationId : ''); restore(); }
            else minimize(true);
        });
        document.addEventListener('keydown', event => { if (event.key !== 'Escape' || document.querySelector('.sc-markdown-dialog')) return; if (dialog) { event.preventDefault(); event.stopImmediatePropagation(); closeDialog(); } else if (document.querySelector('.sc-media-fullscreen')) { event.preventDefault(); event.stopImmediatePropagation(); for (const player of players.values()) player.exitFullscreen(); } else if (isOpen()) { event.preventDefault(); minimize(); } }, true);
        ready.then(async () => { const url = entryUrl; if (url.searchParams.has('stream')) { await open(); navigate('watch', url.searchParams.get('stream'), false, 'discover'); } if (url.searchParams.has('stream_invite')) { await open(); await inspectInvitation(url.searchParams.get('stream_invite')); } }).catch(error);
        return ready;
    }
    global.StreamingConsole = { init, open, minimize, close: closeConsole, isOpen, ownsHistory: () => isOpen() || Boolean(dialog), notification, compose, sendMarkdown, openInvitation, canImportRecord, importRecord, request, inspectInvitation, whenReady: () => ready };
})(window);
