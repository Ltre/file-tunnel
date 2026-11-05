(function (global) {
    'use strict';
    function create({ key, fields, tabs, copy, remove, formatList, readMode, writeMode, paint, parse }) {
        const defaults = readFields();
        let drafts = [], active, next = 1;
        let selecting = false, press, heldPointer, suppressedDraft, suppressClick = 0;
        const selected = new Set();
        try {
            const saved = JSON.parse(localStorage.getItem(key) || 'null');
            if (Array.isArray(saved?.drafts)) {
                drafts = saved.drafts.filter(draft => Number.isSafeInteger(draft.id)).map(draft => ({
                    ...defaults, ...draft, pending: false, submitting: false
                }));
                next = Math.max(1, Number(saved.next) || 1, ...drafts.map(draft => draft.id + 1));
                active = drafts.find(draft => draft.id === saved.active);
            }
        } catch (_) {}
        const blank = () => ({ ...defaults, ids: null, analysis: null, error: '', restoreIds: null });
        if (!drafts.length) drafts.push({ id: next++, ...blank() });
        active ||= drafts[0];

        function readFields() {
            return { mode: readMode(), ...Object.fromEntries(Object.entries(fields).map(([name, input]) =>
                [name, input.type === 'checkbox' ? input.checked : input.value])) };
        }
        function persist() {
            try {
                const snapshot = drafts.map(({ id, mode, ids, restoreIds, ...draft }) => ({
                    id, mode, ids, restoreIds, ...Object.fromEntries(Object.keys(fields).map(name => [name, draft[name]]))
                }));
                localStorage.setItem(key, JSON.stringify({ active: active.id, next, drafts: snapshot }));
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
            if (tab) tab.textContent = active.remark?.trim() || String(active.id);
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
                const button = makeButton(draft.remark?.trim() || String(draft.id), () => {
                    if (Date.now() < suppressClick && suppressedDraft === draft) return;
                    if (!selecting) return select(draft);
                    if (selected.has(draft)) selected.delete(draft); else selected.add(draft);
                    renderTabs();
                }, '表单 ' + draft.id);
                button.dataset.draftId = draft.id;
                button.setAttribute('aria-pressed', String(selecting ? selected.has(draft) : draft === active));
                tabs.append(button);
            }
            tabs.classList.toggle('is-selecting', selecting);
            copy.hidden = selecting; cancelSelection.hidden = selectAll.hidden = !selecting;
            remove.disabled = selecting && !selected.size;
        }
        const cancelSelection = makeButton('取消', () => { selecting = false; selected.clear(); renderTabs(); }, '取消表单多选');
        const selectAll = makeButton('☑', () => { drafts.forEach(draft => selected.add(draft)); renderTabs(); }, '全选表单');
        selectAll.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m7 12 3 3 7-7"/></svg>';
        remove.before(cancelSelection, selectAll);
        function clearPress() { clearTimeout(press?.timer); press = null; }
        tabs.addEventListener('pointerdown', event => {
            const button = event.target.closest('button[data-draft-id]');
            if (!button || event.button !== 0) return;
            clearPress(); const draft = drafts.find(item => String(item.id) === button.dataset.draftId);
            press = { id: event.pointerId, x: event.clientX, y: event.clientY, timer: setTimeout(() => {
                if (!drafts.includes(draft)) return;
                selecting = true; selected.add(draft); heldPointer = event.pointerId; suppressedDraft = draft; suppressClick = Date.now() + 700;
                clearPress(); global.getSelection?.()?.removeAllRanges(); renderTabs();
            }, 550) };
        });
        tabs.addEventListener('pointermove', event => { if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) clearPress(); });
        for (const name of ['pointerup', 'pointercancel', 'pointerleave']) tabs.addEventListener(name, event => {
            if (heldPointer === event.pointerId) { heldPointer = undefined; suppressClick = Date.now() + 700; }
            clearPress();
        });
        tabs.addEventListener('selectstart', event => { if (press || selecting) event.preventDefault(); });
        tabs.addEventListener('contextmenu', event => { if (press || selecting || Date.now() < suppressClick) event.preventDefault(); });
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
            const draft = { id: next++, ...blank(), ...values };
            drafts.splice(drafts.indexOf(active), 0, draft);
            select(draft);
            return draft;
        }
        function update(draft) {
            if (draft === active) display();
            const tab = tabs.querySelector('[data-draft-id="' + draft.id + '"]');
            if (tab) tab.textContent = draft.remark?.trim() || String(draft.id);
            persist();
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
            clearTimeout(draft.timer);
            Object.assign(draft, blank(), { pending: false, request: null });
            if (drafts.length === 1 && drafts[0] === draft) {
                draft.id = 1;
                next = 2;
                renderTabs();
            }
            update(draft);
        }
        copy.onclick = () => {
            const draft = capture();
            insert({ ...readFields(), analysis: draft.analysis, ids: draft.ids?.slice() || null, restoreIds: draft.restoreIds });
        };
        remove.onclick = () => {
            capture();
            const targets = selecting ? [...selected] : [active];
            if (!targets.length || !confirm(selecting ? '删除选中的 ' + targets.length + ' 套任务表单？' : '删除当前任务表单？')) return;
            const index = drafts.indexOf(active);
            for (const draft of targets) { clearTimeout(draft.timer); draft.request = null; }
            drafts = drafts.filter(draft => !targets.includes(draft));
            if (!drafts.length) {
                next = 1;
                drafts.push({ id: next++, ...blank() });
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
        return { capture, update, analyze, schedule, reset, reuse, get active() { return active; } };
    }
    global.DownloadFormTabs = { create };
})(window);
