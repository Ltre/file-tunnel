(function (global) {
    'use strict';
    function create({ key, fields, tabs, copy, remove, formatList, readMode, writeMode, paint, parse, serverForms }) {
        const defaults = readFields();
        let drafts = [], active, next = 1;
        let selecting = false, press, heldPointer, suppressedDraft, suppressClick = 0;
        const selected = new Set();
        const cloudIds = new Set();
        const localId = () => { const used = new Set([...drafts.map(item => item.id), ...cloudIds]); let id = 1; while (used.has(id)) id++; return id; };
        function acceptCloudId(draft, id) {
            cloudIds.add(id);
            const collision = drafts.find(item => item !== draft && item.id === id);
            if (collision) collision.id = localId();
            draft.id = id;
        }
        let pendingDeletes = [], cloudLoading = Boolean(serverForms), flushing = null, cloudButton;
        const cloudFlights = new Set();
        let cloudFeedback = 0;
        const identity = () => global.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
        try {
            const saved = JSON.parse(localStorage.getItem(key) || 'null');
            if (Array.isArray(saved?.drafts)) {
                drafts = saved.drafts.filter(draft => Number.isSafeInteger(draft.id)).map(draft => ({
                    ...defaults, ...draft, pending: false, submitting: false
                }));
                next = Math.max(1, Number(saved.next) || 1, ...drafts.map(draft => draft.id + 1));
                active = drafts.find(draft => draft.id === saved.active);
                pendingDeletes = Array.isArray(saved.cleanup) ? saved.cleanup : [];
            }
        } catch (_) {}
        const blank = () => ({ ...defaults, ids: null, analysis: null, error: '', restoreIds: null });
        if (!drafts.length) drafts.push({ id: next++, ...blank() });
        active ||= drafts[0];
        for (const draft of drafts) draft.clientKey ||= identity();
        const title = draft => (draft.cloudId ? '☁·' : '') + (draft.remark?.trim() || String(draft.cloudId || draft.id));
        const cloudStatus = document.createElement('div'); cloudStatus.className = 'download-form-cloud-status'; cloudStatus.setAttribute('role', 'status'); cloudStatus.hidden = true;
        const retryCleanup = document.createElement('button'); retryCleanup.type = 'button'; retryCleanup.textContent = '重试清理服务器表单'; retryCleanup.hidden = true;
        if (serverForms) tabs.closest('.download-form-heading')?.after(cloudStatus, retryCleanup);
        const report = (text, error = false) => { cloudStatus.textContent = global.TunnelI18n?.t(text) || text; cloudStatus.hidden = !text; cloudStatus.classList.toggle('error', error); };
        async function cloudRequest(suffix = '', method = 'GET', body) {
            const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
            try {
                const response = await fetch('/api/admin-forms/' + serverForms + suffix, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
                    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
                const data = await response.json();
                if (!response.ok) throw Object.assign(new Error(data.error || 'HTTP_' + response.status), { status: response.status });
                return data;
            } finally { clearTimeout(timer); }
        }

        function readFields() {
            return { mode: readMode(), ...Object.fromEntries(Object.entries(fields).map(([name, input]) =>
                [name, input.type === 'checkbox' ? input.checked : input.value])) };
        }
        function persist() {
            try {
                const snapshot = drafts.map(({ id, mode, ids, restoreIds, ...draft }) => ({
                    id, mode, ids, restoreIds, clientKey: draft.clientKey, cloudId: draft.cloudId, cloudRevision: draft.cloudRevision,
                    ...Object.fromEntries(Object.keys(fields).map(name => [name, draft[name]]))
                }));
                localStorage.setItem(key, JSON.stringify({ active: active.id, next, drafts: snapshot, cleanup: pendingDeletes }));
            } catch (_) {}
        }
        function capture() {
            const values = readFields();
            if (values.url.trim() !== active.url.trim()) {
                clearTimeout(active.timer);
                active.request = null;
                Object.assign(active, { analysis: null, pending: false, error: '', ids: null, restoreIds: null });
            } else if (active.analysis && values.mode === 'custom') {
                active.ids = [...formatList.querySelectorAll('input:checked')].map(input => input.value);
            }
            Object.assign(active, values);
            const tab = tabs.querySelector('[data-draft-id="' + active.id + '"]');
            if (tab) tab.textContent = title(active);
            persist();
            return active;
        }
        function display() {
            for (const [name, input] of Object.entries(fields)) {
                if (input.type === 'checkbox') input.checked = Boolean(active[name]);
                else input.value = active[name] || '';
            }
            writeMode(active.mode);
            paint(active);
        }
        function makeButton(label, action, title) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            if (title) { button.title = title; button.setAttribute('aria-label', title); }
            button.onclick = action;
            return button;
        }
        function renderTabs() {
            tabs.replaceChildren(makeButton('+', () => insert(), '新建任务表单'));
            for (const draft of drafts) {
                const button = makeButton(title(draft), () => {
                    if (Date.now() < suppressClick && suppressedDraft === draft) return;
                    if (!selecting) return select(draft);
                    if (selected.has(draft)) selected.delete(draft); else selected.add(draft);
                    renderTabs();
                }, '表单 ' + (draft.cloudId || draft.id));
                button.dataset.draftId = draft.id;
                button.dataset.i18nRaw = 'true';
                button.setAttribute('aria-pressed', String(selecting ? selected.has(draft) : draft === active));
                tabs.append(button);
            }
            tabs.classList.toggle('is-selecting', selecting);
            copy.hidden = selecting; cancelSelection.hidden = selectAll.hidden = !selecting;
            remove.disabled = selecting && !selected.size;
            if (cloudButton) {
                cloudButton.hidden = selecting; cloudButton.disabled = cloudLoading || cloudFlights.has(active) || Boolean(active.submitting);
                cloudButton.classList.toggle('is-cloud-saved', Boolean(active.cloudId));
                cloudButton.title = active.cloudId ? '取消当前表单的云端保存' : '保存当前表单到服务器';
                cloudButton.setAttribute('aria-label', cloudButton.title);
                cloudButton.setAttribute('aria-pressed', String(Boolean(active.cloudId)));
            }
        }
        const cancelSelection = makeButton('取消', () => { selecting = false; selected.clear(); renderTabs(); }, '取消表单多选');
        const selectAll = makeButton('☑', () => { drafts.forEach(draft => selected.add(draft)); renderTabs(); }, '全选表单');
        selectAll.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m7 12 3 3 7-7"/></svg>';
        remove.before(cancelSelection, selectAll);
        if (serverForms) {
            cloudButton = makeButton('☁', saveCloud, '保存当前表单到服务器'); cloudButton.id = 'saveDownloadForm'; copy.before(cloudButton);
        }
        async function saveCloud() {
            const draft = capture(); if (cloudLoading || draft.submitting || cloudFlights.has(draft)) return;
            const removing = Boolean(draft.cloudId);
            if (!draft.cloudId && !['url', 'remark', 'downloadSections', 'manualFormat'].some(name => String(draft[name] || '').trim())) { report('请先填写表单内容。'); return; }
            const feedback = ++cloudFeedback;
            const savedReport = (text, error) => { if (feedback === cloudFeedback) report(text, error); };
            cloudFlights.add(draft); renderTabs(); report(draft.cloudId ? '正在移除服务器表单…' : '正在保存服务器表单…');
            const data = { preferredId: draft.id, localIds: drafts.filter(item => item !== draft).map(item => item.id), clientKey: draft.clientKey, revision: draft.cloudRevision, form: { mode: draft.mode, ...Object.fromEntries(Object.keys(fields).map(name => [name, draft[name]])) }, analysis: draft.analysis, ids: draft.ids };
            try {
                if (draft.cloudId) {
                    const id = draft.cloudId;
                    await cloudRequest('/' + id, 'DELETE', { revision: draft.cloudRevision });
                    cloudIds.delete(id);
                    if (draft.clientKey === data.clientKey) { draft.cloudId = undefined; draft.cloudRevision = undefined; draft.clientKey = identity(); }
                    persist(); renderTabs(); savedReport('已取消云端保存，本地表单内容已保留。'); return;
                }
                const { form } = await cloudRequest('', 'POST', data);
                if (draft.clientKey !== data.clientKey) {
                    const cleanup = { id: form.id, revision: form.revision };
                    pendingDeletes.push(cleanup); persist(); savedReport('任务已提交，正在清理服务器表单…');
                    await flushDeletes(); if (!pendingDeletes.includes(cleanup) && !cleanup.preserved) savedReport('已清理提交任务的服务器表单。'); return;
                }
                if (drafts.includes(draft)) { acceptCloudId(draft, form.id); draft.cloudId = form.id; draft.cloudRevision = form.revision; persist(); renderTabs(); }
                savedReport('表单已保存到服务器。再次点击云按钮可取消云端保存。');
            } catch (error) {
                if (error.status === 404 && draft.clientKey === data.clientKey) { draft.cloudId = undefined; draft.cloudRevision = undefined; persist(); }
                savedReport((removing ? '服务器表单删除失败，本地内容已保留：' : '服务器表单保存失败，本地内容已保留：') + error.message, true);
            }
            finally { cloudFlights.delete(draft); renderTabs(); }
        }
        async function flushDeletes() {
            if (flushing || !serverForms || !pendingDeletes.length) return flushing;
            const attempted = new Set();
            flushing = (async () => {
                let entry;
                while ((entry = pendingDeletes.find(item => !attempted.has(item)))) {
                    attempted.add(entry);
                    try {
                        await cloudRequest('/' + entry.id, 'DELETE', { revision: entry.revision });
                    } catch (error) {
                        if (error.status === 409) { entry.preserved = true; report('服务器表单已有新版本，旧任务不会删除该新版本。', true); }
                        else { report('任务已提交，但服务器表单清理未完成，请重试清理：' + error.message, true); retryCleanup.hidden = false; continue; }
                    }
                    if (!entry.preserved) cloudIds.delete(entry.id);
                    pendingDeletes = pendingDeletes.filter(item => item !== entry); persist();
                }
                retryCleanup.hidden = !pendingDeletes.length;
            })();
            try { await flushing; } finally { flushing = null; if (pendingDeletes.some(item => !attempted.has(item))) flushDeletes(); }
        }
        retryCleanup.onclick = () => flushDeletes();
        async function loadCloud() {
            if (!serverForms) return;
            try {
                const { forms } = await cloudRequest(); capture();
                const present = new Set(forms.map(record => record.id));
                cloudIds.clear(); for (const id of present) cloudIds.add(id);
                for (const draft of drafts) if (draft.cloudId && !present.has(draft.cloudId)) { draft.cloudId = undefined; draft.cloudRevision = undefined; }
                for (const record of forms) {
                    if (pendingDeletes.some(entry => entry.id === record.id && entry.revision === record.revision)) continue;
                    let draft = drafts.find(item => item.clientKey === record.clientKey || item.cloudId === record.id);
                    if (draft && (draft.submitting || cloudFlights.has(draft))) continue;
                    if (draft) {
                        if (draft.cloudId && draft.cloudRevision !== record.revision) {
                            // Keep a separate local copy of edits before accepting
                            // a newer server version; never discard browser data.
                            drafts.push({ ...draft, id: localId(), clientKey: identity(), cloudId: undefined, cloudRevision: undefined, timer: undefined, request: null, pending: false, submitting: false });
                            clearTimeout(draft.timer);
                            Object.assign(draft, blank(), record.form, { timer: undefined, request: null, pending: false });
                        }
                    } else {
                        draft = drafts.length === 1 && !active.cloudId && !active.submitting && active.mode === defaults.mode && Object.keys(fields).every(name => active[name] === defaults[name]) ? active : { id: localId(), ...blank() };
                        if (!drafts.includes(draft)) drafts.push(draft);
                        Object.assign(draft, record.form);
                    }
                    const sameUrl = draft.url?.trim() === record.form.url?.trim();
                    Object.assign(draft, { clientKey: record.clientKey, cloudId: record.id, cloudRevision: record.revision });
                    acceptCloudId(draft, record.id);
                    if (sameUrl && !draft.pending) { draft.analysis = record.analysis; draft.ids ||= record.ids; }
                }
                display(); persist(); renderTabs(); schedule(active);
            } catch (error) { report('服务器表单读取失败，本地表单仍可使用：' + error.message, true); }
            finally { cloudLoading = false; renderTabs(); flushDeletes(); }
        }
        function clearPress() { clearTimeout(press?.timer); press = null; }
        function beginSelection(draft) {
            if (!drafts.includes(draft)) return;
            selecting = true; selected.add(draft); suppressedDraft = draft; suppressClick = Date.now() + 700;
            clearPress(); global.getSelection?.()?.removeAllRanges(); renderTabs();
        }
        tabs.addEventListener('pointerdown', event => {
            if (event.pointerType !== 'touch') return;
            if (event.isPrimary === false) { clearPress(); return; }
            const button = event.target.closest('button[data-draft-id]');
            if (!button || event.button !== 0) return;
            clearPress(); const draft = drafts.find(item => String(item.id) === button.dataset.draftId);
            press = { id: event.pointerId, x: event.clientX, y: event.clientY, timer: setTimeout(() => {
                heldPointer = event.pointerId; beginSelection(draft);
            }, 550) };
        });
        tabs.addEventListener('pointermove', event => { if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) clearPress(); });
        for (const name of ['pointerup', 'pointercancel', 'pointerleave']) tabs.addEventListener(name, event => {
            if (heldPointer === event.pointerId) { heldPointer = undefined; suppressClick = Date.now() + 700; }
            clearPress();
        });
        tabs.addEventListener('selectstart', event => { if (press || selecting) event.preventDefault(); });
        tabs.addEventListener('contextmenu', event => {
            const button = event.target.closest('button[data-draft-id]');
            if (!button) return;
            event.preventDefault();
            if (event.pointerType === 'touch' || heldPointer !== undefined) return;
            beginSelection(drafts.find(item => String(item.id) === button.dataset.draftId));
        });
        function select(draft) {
            if (draft === active) return;
            capture();
            active = draft;
            renderTabs();
            display();
            persist();
            schedule(draft);
        }
        function insert(values = {}) {
            capture();
            const draft = { id: localId(), clientKey: identity(), ...blank(), ...values };
            drafts.splice(drafts.indexOf(active), 0, draft);
            select(draft);
            return draft;
        }
        function update(draft) {
            if (draft === active) display();
            const tab = tabs.querySelector('[data-draft-id="' + draft.id + '"]');
            if (tab) tab.textContent = title(draft);
            persist();
            if (cloudButton) cloudButton.disabled = cloudLoading || cloudFlights.has(active) || Boolean(active.submitting);
        }
        async function analyze(draft, refresh = false) {
            clearTimeout(draft.timer);
            const url = draft.url.trim();
            if (!url || draft.mode !== 'custom' || !drafts.includes(draft)) return;
            const request = {};
            draft.request = request;
            Object.assign(draft, { pending: true, error: '', analysis: null });
            update(draft);
            try {
                const result = await parse(url, refresh);
                if (draft.request !== request) return;
                draft.analysis = result;
                const available = new Set((result.formats || []).filter(format =>
                    ['audio', 'video', 'video_audio'].includes(format.kind) && (!draft.asMusic || format.kind === 'audio')).map(format => format.id));
                if (draft.restoreIds?.length && draft.restoreIds.every(id => available.has(id))) {
                    const selected = result.formats.filter(format => draft.restoreIds.includes(format.id));
                    const valid = selected.length === 1 || selected.length === 2 && selected.some(f => f.kind === 'audio') && selected.some(f => f.kind === 'video');
                    if (valid) {
                        Object.assign(draft, { ids: draft.restoreIds, restoreIds: null, manualFormat: '', useManualFormat: false });
                    }
                }
                if (draft.ids) draft.ids = draft.ids.filter(id => available.has(id));
            } catch (error) {
                if (draft.request === request) draft.error = error.message;
            } finally {
                if (draft.request === request) { draft.pending = false; update(draft); }
            }
        }
        function schedule(draft = capture()) {
            clearTimeout(draft.timer);
            if (draft.analysis || draft.pending || draft.error || draft.mode !== 'custom' || !draft.url.trim() ||
                (draft.useManualFormat && draft.manualFormat.trim() && !draft.restoreIds?.length)) return;
            draft.timer = setTimeout(() => analyze(draft), 650);
        }
        function reuse(task) {
            const original = capture();
            const ids = (task.selectedFormatIds || []).map(String);
            const manual = task.manualFormat || ids.join('+');
            const values = { url: task.url || '', mode: manual ? 'custom' : task.mode || 'default',
                asMusic: task.asMusic === true, cacheFiles: task.cacheFiles ?? (task.autoCacheEnabled !== false && defaults.cacheFiles),
                downloadSections: task.downloadSections || '', remark: task.remark || '',
                manualFormat: manual, useManualFormat: Boolean(manual), restoreIds: ids };
            if (original.submitting || Object.keys(fields).some(name => original[name] !== defaults[name]) || original.mode !== defaults.mode) {
                const draft = insert(values);
                if (manual) analyze(draft);
            } else {
                Object.assign(original, blank(), values);
                update(original);
                if (manual) analyze(original);
            }
            tabs.scrollIntoView({ block: 'nearest' });
        }
        function reset(draft) {
            if (!drafts.includes(draft)) return;
            if (draft.cloudId) pendingDeletes.push({ id: draft.cloudId, revision: draft.cloudRevision });
            clearTimeout(draft.timer);
            Object.assign(draft, blank(), { pending: false, request: null, clientKey: identity(), cloudId: undefined, cloudRevision: undefined });
            if (drafts.length === 1 && drafts[0] === draft) {
                draft.id = 1;
                next = 2;
                renderTabs();
            }
            update(draft);
            flushDeletes();
        }
        copy.onclick = () => {
            const draft = capture();
            insert({ ...readFields(), analysis: draft.analysis, ids: draft.ids?.slice() || null, restoreIds: draft.restoreIds });
        };
        remove.onclick = async () => {
            capture();
            const targets = selecting ? [...selected] : [active];
            if (targets.some(draft => draft.submitting || cloudFlights.has(draft)) || cloudLoading) { report('表单操作尚未完成，请稍后再删除。', true); return; }
            if (!targets.length || !confirm(selecting ? '删除选中的 ' + targets.length + ' 套任务表单？' : '删除当前任务表单？')) return;
            const index = drafts.indexOf(active);
            for (const draft of targets) {
                cloudFlights.add(draft); renderTabs();
                try {
                    if (draft.cloudId) { await cloudRequest('/' + draft.cloudId, 'DELETE', { revision: draft.cloudRevision }); cloudIds.delete(draft.cloudId); }
                    clearTimeout(draft.timer); draft.request = null; drafts = drafts.filter(item => item !== draft);
                } catch (error) { report('服务器表单删除失败，本地内容已保留：' + error.message, true); }
                finally { cloudFlights.delete(draft); }
            }
            if (!drafts.length) {
                next = 1;
                drafts.push({ id: next++, clientKey: identity(), ...blank() });
            }
            if (!drafts.includes(active)) active = drafts[Math.min(index, drafts.length - 1)];
            selecting = false; selected.clear();
            display();
            renderTabs();
            persist();
            schedule(active);
        };
        renderTabs();
        display();
        schedule(active);
        const ready = loadCloud();
        return { capture, update, analyze, schedule, reset, reuse, ready, get active() { return active; } };
    }
    global.DownloadFormTabs = { create };
})(window);
