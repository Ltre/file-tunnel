(function (global) {
    'use strict';
    const DB_NAME = 'TunnelBrowserLogs', MAX_BYTES = 64 * 1024 * 1024, MAX_ENTRIES = 100000, PAGE_SIZE = 100;
    const t = (key, ...args) => (global.TunnelI18n?.t(key) || key).replace(/\{(\d+)\}/g, (_m, i) => args[i] ?? _m);
    const pending = [], original = {};
    let dbPromise, timer, writer = Promise.resolve(), storageError = '', context = () => ({});
    const redact = value => String(value).replace(/\bBearer\s+[\w.\-]+/gi, 'Bearer [redacted]')
        .replace(/((?:auth_token|ct0|cookie|authorization|password|access[_-]?token|accessGrant|joinToken)\s*[:=]\s*)[^\s,;&]+/gi, '$1[redacted]')
        .replace(/([?&](?:token|key|signature|grant|auth|invite)[^=\s]*=)[^&\s]+/gi, '$1[redacted]');
    function summarize(values) {
        let budget = 150; const seen = new WeakSet();
        function clean(value, depth = 0) {
            if (--budget < 0) return '[truncated]';
            if (typeof value === 'string') return redact(value.slice(0, 1800));
            if (value instanceof Error) return { name: value.name, message: redact(value.message), stack: redact(String(value.stack || '').slice(0, 3500)) };
            if (value == null || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
            if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return '[binary ' + value.byteLength + ' bytes]';
            if (value instanceof Blob) return '[Blob ' + value.size + ' bytes]';
            if (seen.has(value) || depth > 3) return '[object]'; seen.add(value);
            if (Array.isArray(value)) return value.slice(0, 12).map(item => clean(item, depth + 1));
            const result = {};
            for (const key of Object.keys(value).slice(0, 25)) {
                if (/cookie|password|secret|authorization|token|grant/i.test(key)) result[key] = '[redacted]';
                else if (/^(data|content|html|markdown)$/i.test(key)) result[key] = '[omitted]';
                else { try { result[key] = clean(value[key], depth + 1); } catch (_) { result[key] = '[unavailable]'; } }
            }
            return result;
        }
        try { return values.slice(0, 12).map(value => typeof value === 'string' ? clean(value) : JSON.stringify(clean(value))).join(' ').slice(0, 6000); }
        catch (_) { return '[unavailable log details]'; }
    }
    function openDb() {
        if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                const entries = request.result.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
                entries.createIndex('kindTime', ['kind', 'time']);
                request.result.createObjectStore('meta');
            };
            request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); dbPromise = null; }; resolve(db); };
            request.onerror = () => reject(request.error);
        }).catch(error => { dbPromise = null; storageError = error.name || error.message; throw error; });
        return dbPromise;
    }
    function record(kind, ...args) {
        if (pending.length >= 200) return;
        const message = summarize(args); if (!message) return;
        let identity = {}; try { identity = context() || {}; } catch (_) {}
        pending.push({ kind: kind === 'error' ? 'error' : 'operation', time: Date.now(), message,
            sessionId: String(identity.sessionId || ''), deviceId: String(identity.deviceId || '') });
        if (!timer) timer = setTimeout(() => { timer = null; flush(); }, 500);
    }
    function flush() {
        clearTimeout(timer); timer = null;
        if (!pending.length) return writer;
        const batch = pending.splice(0);
        writer = writer.catch(() => {}).then(async () => {
            const db = await openDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(['entries', 'meta'], 'readwrite'), entries = tx.objectStore('entries'), meta = tx.objectStore('meta');
                const request = meta.get('stats');
                request.onsuccess = () => {
                    const stats = request.result || { count: 0, bytes: 0 };
                    for (const entry of batch) {
                        entry.bytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
                        if (stats.count >= MAX_ENTRIES || stats.bytes + entry.bytes > MAX_BYTES) { storageError = 'LOG_STORAGE_FULL'; break; }
                        entries.add(entry); stats.count++; stats.bytes += entry.bytes;
                    }
                    meta.put(stats, 'stats');
                };
                tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || Error('LOG_WRITE_FAILED')); tx.onerror = () => {};
            });
        }).catch(error => { storageError = error.name || error.message; });
        return writer;
    }
    const position = entry => ({ time: entry.time, id: entry.id });
    const comparePosition = (a, b) => a.time - b.time || a.id - b.id;
    function matches(entry, filter) {
        return (!filter.keyword || entry.message.toLocaleLowerCase().includes(filter.keyword.toLocaleLowerCase())) &&
            (!filter.firstId || entry.id >= filter.firstId) && (!filter.lastId || entry.id <= filter.lastId) &&
            (!filter.spanFrom || comparePosition(entry, filter.spanFrom) >= 0) &&
            (!filter.spanTo || comparePosition(entry, filter.spanTo) <= 0) &&
            (!filter.before || (typeof filter.before === 'object' ? comparePosition(entry, filter.before) < 0 : entry.id < filter.before));
    }
    async function visit(filter, callback, write = false) {
        await flush(); const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(write ? ['entries', 'meta'] : ['entries'], write ? 'readwrite' : 'readonly');
            const store = tx.objectStore('entries'); let stopped = false;
            let stats, dirty = false;
            if (write) { const request = tx.objectStore('meta').get('stats'); request.onsuccess = () => { stats = request.result || { count: 0, bytes: 0 }; }; }
            const saveStats = () => { if (dirty) { tx.objectStore('meta').put(stats, 'stats'); dirty = false; } };
            const to = Math.min(filter.to ?? Date.now(), typeof filter.before === 'object' ? filter.before.time : Infinity);
            const request = store.index('kindTime').openCursor(IDBKeyRange.bound([filter.kind, filter.from || 0], [filter.kind, to]), 'prev');
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || stopped) { saveStats(); return; }
                if (matches(cursor.value, filter)) {
                    const action = callback(cursor.value);
                    if (write && action === 'delete') { cursor.delete(); stats.count = Math.max(0, stats.count - 1); stats.bytes = Math.max(0, stats.bytes - (cursor.value.bytes || 0)); dirty = true; }
                    if (action === false) { stopped = true; saveStats(); return; }
                }
                cursor.continue();
            };
            tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || Error('LOG_QUERY_FAILED')); tx.onerror = () => {};
        });
    }
    async function query(filter, limit = PAGE_SIZE) { const result = []; await visit(filter, entry => { result.push(entry); return result.length < limit; }); return result; }
    async function count(filter) { let result = 0; await visit(filter, () => { result++; }); return result; }
    async function remove(filter) { let removed = 0; await visit(filter, () => { removed++; return 'delete'; }, true); storageError = ''; return removed; }
    function timeRange(value, now = Date.now(), start, end) {
        if (value === 'custom') {
            const from = new Date(start).getTime(), to = new Date(end).getTime() + 59999;
            if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw Error('请选择有效的起止时间');
            return { from, to };
        }
        if (value === 'all') return { from: 0, to: now };
        const months = { month: 1, quarter: 3, half: 6, year: 12 };
        if (months[value]) { const from = new Date(now), day = from.getDate(); from.setDate(1); from.setMonth(from.getMonth() - months[value]); from.setDate(Math.min(day,new Date(from.getFullYear(),from.getMonth()+1,0).getDate())); return { from: from.getTime(), to: now }; }
        const minutes = { m15: 15, h1: 60, h3: 180, d1: 1440, d3: 4320, w1: 10080, w2: 20160 }[value];
        if (!minutes) throw Error('请选择有效的起止时间');
        return { from: now - minutes * 60000, to: now };
    }
    async function exportLogs(filter) {
        filter = { ...filter, to: filter.to ?? Date.now() };
        const parts = [JSON.stringify({ format: 'TunnelBrowserLogs', version: 1, exportedAt: new Date().toISOString(), filter }) + '\n'];
        let page, before;
        do {
            page = await query({ ...filter, before }, 500);
            for (const entry of page) { const { bytes, ...record } = entry; parts.push(JSON.stringify({ ...record, timestamp: new Date(entry.time).toISOString() }) + '\n'); }
            before = page.length ? position(page.at(-1)) : undefined;
        } while (page.length === 500);
        return new Blob(parts, { type: 'application/x-ndjson;charset=utf-8' });
    }
    function open(kind) {
        const layer = document.createElement('div'); layer.className = 'browser-log-layer';
        const panel = document.createElement('section'); panel.className = 'browser-log-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
        const make = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = t(text); if (className) node.className = className; return node; };
        const header = make('header'), title = make('h2', kind === 'error' ? '查看错误日志' : '查看普通操作日志'), close = make('button', '关闭'); close.type = 'button';
        const controls = make('div', '', 'browser-log-filters'), range = make('select'), keyword = make('input'), start = make('input'), end = make('input');
        range.setAttribute('aria-label', t('时间范围')); keyword.type = 'search'; keyword.placeholder = t('关键词检索'); keyword.setAttribute('aria-label', t('关键词检索'));
        for (const [value, label] of [['m15','15分钟内'],['h1','1小时内'],['h3','3小时内'],['d1','1天内'],['d3','3天内'],['w1','1周内'],['w2','2周内'],['month','1个月内'],['quarter','3个月内'],['half','半年内'],['year','一年内'],['all','全部'],['custom','自定义时间范围']]) { const option = make('option', label); option.value = value; range.append(option); }
        range.value = 'all'; start.type = end.type = 'datetime-local'; start.step = end.step = '60'; start.hidden = end.hidden = true;
        start.setAttribute('aria-label', t('起始时间')); end.setAttribute('aria-label', t('结束时间'));
        range.onchange = () => { start.hidden = end.hidden = range.value !== 'custom'; };
        const search = make('button','筛选日志'), refresh = make('button','刷新'), exportButton = make('button','导出检索结果'), erase = make('button','删除检索范围'), selected = make('button','删除首尾范围');
        const actions = make('div','','browser-log-actions'), status = make('p','','browser-log-status'), list = make('ol','','browser-log-list'), next = make('button','下一页'), previous = make('button','上一页');
        const note = make('p','日志只保存在当前浏览器，最多缓存10万条或64 MiB；满后暂停记录，清理后继续。','browser-log-note');
        status.setAttribute('role','status'); header.append(title,close); controls.append(range,start,end,keyword,search,refresh); actions.append(exportButton,erase,selected); panel.append(header,controls,actions,status,list,previous,next,note); layer.append(panel); document.body.append(layer);
        let filter, generation = 0, busy = false, pages = [undefined], pageIndex = 0, entries = [], firstId, lastId;
        const setBusy = value => { busy = value; for (const button of [search,refresh,exportButton,erase,selected,next,previous]) button.disabled = value; if (value) status.textContent = t('正在读取日志...'); };
        function currentFilter() { return { kind, ...timeRange(range.value, Date.now(), start.value, end.value), keyword: keyword.value.trim() }; }
        function selectionFilter() {
            if (!firstId || !lastId) throw Error('请先选择首尾日志');
            const [spanFrom, spanTo] = [firstId, lastId].sort(comparePosition);
            return { ...filter, spanFrom, spanTo };
        }
        async function run(action) { if (busy) return; setBusy(true); try { await action(); } catch (error) { if (layer.isConnected) status.textContent = t(error.message) + ' [' + (error.name || 'Error') + ']'; } finally { if (layer.isConnected) setBusy(false); } }
        function render() {
            list.replaceChildren();
            for (const entry of entries) {
                const row = make('li'), meta = make('div','','browser-log-entry-heading'), time = make('time'); time.dateTime = new Date(entry.time).toISOString(); time.textContent = new Date(entry.time).toLocaleString() + ' · #' + entry.id;
                const first = make('button','设为首条'), last = make('button','设为尾条');
                first.onclick = () => { firstId = position(entry); render(); }; last.onclick = () => { lastId = position(entry); render(); };
                first.setAttribute('aria-pressed',String(firstId?.id === entry.id)); last.setAttribute('aria-pressed',String(lastId?.id === entry.id));
                meta.append(time,first,last); const details = make('pre'); details.textContent = entry.message; row.append(meta,details); list.append(row);
            }
            if (!entries.length) list.append(make('li','没有匹配的日志'));
            status.textContent = t('当前页 {0} 条',entries.length) + (firstId || lastId ? ' · ' + t('首尾：{0} / {1}',firstId?.id || '—',lastId?.id || '—') : '') + (storageError ? ' · '+t(storageError === 'LOG_STORAGE_FULL' ? '日志缓存已满，请清理后继续记录' : '日志缓存不可用') : '');
            previous.hidden = pageIndex === 0; next.hidden = entries.length < PAGE_SIZE;
            erase.textContent = t(range.value === 'all' && !filter.keyword ? '全部删除' : '删除检索范围');
        }
        async function load(reset) {
            const version = ++generation;
            if (reset) { filter = currentFilter(); pages = [undefined]; pageIndex = 0; firstId = lastId = undefined; }
            const result = await query({ ...filter, before: pages[pageIndex] });
            if (!layer.isConnected || version !== generation) return;
            entries = result; render();
        }
        search.onclick = refresh.onclick = () => run(() => load(true)); keyword.onkeydown = event => { if (event.key === 'Enter') search.click(); };
        next.onclick = () => run(async () => { pages[++pageIndex] = position(entries.at(-1)); await load(false); }); previous.onclick = () => run(async () => { pageIndex--; await load(false); });
        async function eraseFilter(target) {
            const total = await count(target);
            if (!total) { status.textContent = t('没有匹配的日志'); return; }
            if (!global.confirm(t('确定删除匹配范围内的 {0} 条日志？此操作不可撤销。',total))) { render(); return; }
            await remove(target); await load(true); status.textContent = t('已删除 {0} 条日志',total);
        }
        erase.onclick = () => run(() => eraseFilter(filter)); selected.onclick = () => run(() => eraseFilter(selectionFilter()));
        exportButton.onclick = () => run(async () => {
            const blob = await exportLogs(filter), url = URL.createObjectURL(blob), anchor = document.createElement('a');
            anchor.href = url; anchor.download = 'tunnel-'+kind+'-logs-'+new Date().toISOString().replace(/[:.]/g,'-')+'.jsonl'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            status.textContent = t('日志已导出');
        });
        const escape = event => { if (event.key === 'Escape') close.click(); };
        close.onclick = () => { generation++; layer.remove(); document.removeEventListener('keydown',escape); };
        layer.onclick = event => { if (event.target === layer) close.click(); }; document.addEventListener('keydown',escape);
        run(() => load(true));
    }
    for (const level of ['log','info','debug','warn','error']) {
        original[level] = global.console[level]?.bind(global.console);
        global.console[level] = (...args) => { original[level]?.(...args); if (String(args[0] || '').startsWith('[debug][client]')) return; record(level === 'error' || level === 'warn' || /failed|error|失败/i.test(String(args[0] || '')) ? 'error' : 'operation', ...args); };
    }
    global.addEventListener('error', event => record('error', event.error || event.message || 'Resource load failed', { file: event.filename || event.target?.src, line: event.lineno }), true);
    global.addEventListener('unhandledrejection', event => record('error', event.reason));
    global.addEventListener('pagehide', () => { flush(); });
    document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('viewErrorLogsBtn')?.addEventListener('click', () => open('error'));
        document.getElementById('viewOperationLogsBtn')?.addEventListener('click', () => open('operation'));
    });
    global.BrowserLogs = { record, flush, query, count, remove, exportLogs, timeRange, open, setContext: value => { context = value; } };
})(window);
