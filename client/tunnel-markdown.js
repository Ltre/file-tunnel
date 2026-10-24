(function (global) {
    'use strict';
    const refs = body => [...new Set([...String(body).matchAll(/tunnel-blob:([\w-]+)\/([\w.-]+)\/([\w.-]+)/g)].map(match => match[0]))];
    const t = value => global.TunnelI18n?.t(value) || value;
    let options = {};
    function fromHtml(html, sessionId = '') {
        const root = document.createElement('div'); root.innerHTML = html;
        const escape = value => String(value).replace(/([\\`*_[\]<>])/g, '\\$1');
        const url = value => /^(https?:\/\/|tunnel-blob:|\/)/i.test(value || '') ? String(value).replace(/\s/g, '%20').replace(/\)/g, '%29') : '';
        const walk = node => {
            if (node.nodeType === 3) return escape(node.nodeValue.replace(/\u00a0/g, ' '));
            if (node.nodeType !== 1 || /^(SCRIPT|STYLE|IFRAME|OBJECT|BUTTON)$/.test(node.tagName) || node.hasAttribute('data-tunnel-asset-placeholder')) return '';
            const tag = node.tagName, children = () => [...node.childNodes].map(walk).join('');
            if (tag === 'BR') return '\n';
            if (tag === 'PRE') { const text = node.textContent; const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1))); return '\n\n' + fence + '\n' + text + '\n' + fence + '\n\n'; }
            if (tag === 'CODE') return '`' + node.textContent.replace(/`/g, '\\`') + '`';
            if (tag === 'IMG') {
                const src = node.dataset.tunnelAssetId && sessionId ? 'tunnel-blob:' + sessionId + '/editor-assets/' + node.dataset.tunnelAssetId : url(node.getAttribute('src'));
                return src ? '![' + escape(node.alt || node.dataset.tunnelAssetName || '') + '](' + src + ')' : escape(node.alt || '');
            }
            const text = children();
            if (/^H[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + text + '\n\n';
            if (tag === 'STRONG' || tag === 'B') return '**' + text + '**';
            if (tag === 'EM' || tag === 'I') return '*' + text + '*';
            if (tag === 'DEL' || tag === 'S') return '~~' + text + '~~';
            if (tag === 'A') { const href = url(node.getAttribute('href')); return href ? '[' + text + '](' + href + ')' : text; }
            if (tag === 'LI') return (node.parentElement?.tagName === 'OL' ? String([...node.parentElement.children].indexOf(node) + 1) + '. ' : '- ') + text.trim().replace(/\n/g, '\n  ') + '\n';
            if (tag === 'UL' || tag === 'OL') return '\n\n' + text + '\n';
            if (tag === 'BLOCKQUOTE') return '\n\n' + text.trim().split('\n').map(line => '> ' + line).join('\n') + '\n\n';
            if (tag === 'HR') return '\n\n---\n\n';
            if (tag === 'TABLE') return '\n\n' + [...node.rows].map((row, index) => '| ' + [...row.cells].map(cell => walk(cell).trim().replace(/\|/g, '\\|').replace(/\n/g, '<br>')).join(' | ') + ' |' + (index === 0 ? '\n| ' + [...row.cells].map(() => '---').join(' | ') + ' |' : '')).join('\n') + '\n\n';
            return ['P', 'DIV', 'SECTION'].includes(tag) ? text + '\n\n' : text;
        };
        return [...root.childNodes].map(walk).join('').trim();
    }
    function versions(message) {
        const version = Number(message.markdownVersion) || 1;
        const entries = new Map((Array.isArray(message.markdownHistory) ? message.markdownHistory : []).filter(item => item && typeof item.content === 'string' && Number.isSafeInteger(item.version) && item.version > 0 && item.version <= version).map(item => [item.version, item]));
        if (entries.get(version)?.content !== message.markdown) entries.set(version, { version, content: String(message.markdown || ''), editorDeviceId: message.sender, editorDeviceName: message.senderName, editedAt: message.timestamp });
        return [...entries.values()].sort((a, b) => a.version - b.version);
    }
    async function recordDialog(message, editing) {
        message = await options.record?.(message.id) || message;
        const layer = document.createElement('div'); layer.className = 'sc-dialog sc-markdown-dialog';
        const panel = document.createElement('section'), header = document.createElement('header'), heading = document.createElement('strong');
        panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); heading.textContent = t(editing ? '编辑 Markdown' : 'Markdown 修改历史');
        const button = (label, run) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t(label); b.onclick = run; return b; };
        const close = () => { layer.remove(); document.removeEventListener('keydown', escape, true); };
        const escape = event => { if (event.key === 'Escape' && [...document.querySelectorAll('.sc-markdown-dialog')].at(-1) === layer) { event.preventDefault(); event.stopImmediatePropagation(); close(); } };
        document.addEventListener('keydown', escape, true);
        header.append(heading, button('关闭', close)); panel.append(header); layer.append(panel); document.body.append(layer);
        if (!editing) {
            const history = versions(message), controls = document.createElement('div'), left = document.createElement('select'), right = document.createElement('select');
            const grid = document.createElement('div'); grid.className = 'sc-markdown-diff';
            for (const version of history) {
                const label = t('版本') + ' ' + version.version + ' · ' + (version.editorDeviceName || version.editorDeviceId || '') + ' · ' + new Date(version.editedAt || 0).toLocaleString();
                left.add(new Option(label, version.version)); right.add(new Option(label, version.version));
            }
            left.value = String(history[Math.max(0, history.length - 2)].version); right.value = String(history.at(-1).version);
            left.setAttribute('aria-label', t('对比旧版本')); right.setAttribute('aria-label', t('对比新版本'));
            const update = () => {
                grid.replaceChildren(); const a = history.find(v => String(v.version) === left.value).content.split('\n'), b = history.find(v => String(v.version) === right.value).content.split('\n');
                let prefix = 0, suffix = 0; while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
                while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
                for (const [lines, kind] of [[a, 'removed'], [b, 'added']]) { const pane = document.createElement('pre'); pane.className = 'message-content';
                    lines.forEach((line, index) => { const row = document.createElement('div'); row.textContent = line || ' '; if (index >= prefix && index < lines.length - suffix) row.className = kind; pane.append(row); }); grid.append(pane); }
            };
            left.onchange = right.onchange = update; controls.append(left, right); panel.append(controls, grid); update(); return;
        }
        const input = document.createElement('textarea'), status = document.createElement('p'); input.value = message.markdown; input.rows = 16; input.className = 'message-content'; status.setAttribute('role', 'status');
        let baseVersion = Number(message.markdownVersion) || 1;
        const save = button('保存修改', async () => {
            save.disabled = true; status.textContent = t('正在保存修改…');
            try {
                const result = await options.edit(message, input.value, baseVersion);
                if (!layer.isConnected) return;
                if (result?.ok) { close(); return; }
                if (result?.conflict) {
                    status.replaceChildren(document.createTextNode(t('记录已被更新，本地内容仍保留。请对照最新版本后再次保存。')));
                    const online = document.createElement('pre'); online.className = 'message-content'; online.textContent = result.message.markdown; status.append(online);
                    baseVersion = Number(result.message.markdownVersion) || 1; message = result.message;
                } else status.textContent = t('修改未保存，请检查连接或权限后重试') + ' [' + (result?.error || 'unknown') + ']';
            } catch (error) { status.textContent = t('修改未保存，请检查连接或权限后重试') + ' [' + error.message + ']'; }
            finally { save.disabled = false; }
        });
        const actions = document.createElement('footer'); actions.className = 'sc-markdown-edit-actions';
        actions.append(save, button('修改历史', () => recordDialog(message, false)), button('插入隧道媒体', async event => {
            const control = event.currentTarget; control.disabled = true; status.textContent = t('正在加载资源列表…');
            try {
                const candidates = await options.media(message); if (!layer.isConnected) return;
                panel.querySelector('.sc-markdown-media-list')?.remove(); const list = document.createElement('div'); list.className = 'sc-markdown-media-list';
                for (const item of candidates) list.append(button(item.name, () => {
                    const source = item.source, reference = 'tunnel-blob:' + source.sessionId + '/' + source.messageId + '/' + source.fileId;
                    const text = ['audio', 'video'].includes(item.kind) ? '<' + item.kind + ' controls src="' + reference + '"></' + item.kind + '>' : (item.kind === 'image' ? '!' : '') + '[' + item.name.replace(/[\[\]]/g, '') + '](' + reference + ')';
                    input.setRangeText('\n' + text + '\n', input.selectionStart, input.selectionEnd, 'end'); input.focus(); list.remove();
                }));
                if (!candidates.length) list.textContent = t('暂无可用的隧道媒体'); list.append(button('收起', () => list.remove())); actions.before(list); status.textContent = '';
            } catch (error) { status.textContent = t('资源列表加载失败，请重试') + ' [' + error.message + ']'; } finally { control.disabled = false; }
        }), button('预览', () => previewRecord({ ...message, markdown: input.value })));
        panel.append(input, status, actions); input.focus();
    }
    async function previewRecord(message) {
        const layer = document.createElement('div'); layer.className = 'sc-dialog sc-markdown-dialog sc-markdown-reader';
        const panel = document.createElement('section'), header = document.createElement('header'), title = document.createElement('strong'), content = document.createElement('div'), status = document.createElement('p');
        title.textContent = t('Markdown 预览'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); content.className = 'sc-document message-content';
        let resolved; const controller = new AbortController();
        const close = () => { controller.abort(); resolved?.close(); layer.remove(); document.removeEventListener('keydown', escape, true); };
        const escape = event => { if (event.key === 'Escape' && [...document.querySelectorAll('.sc-markdown-dialog')].at(-1) === layer) { event.preventDefault(); event.stopImmediatePropagation(); close(); } };
        const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = t('关闭'); dismiss.onclick = close;
        const loading = document.createElement('div'); loading.className = 'sc-markdown-loading'; loading.textContent = t('正在加载 Markdown…'); loading.setAttribute('role', 'status');
        const actions = document.createElement('footer'); actions.className = 'sc-markdown-reader-actions';
        const action = (label, run) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = t(label); node.onclick = async () => { node.disabled = true; try { await run(); } catch (error) { if (layer.isConnected) status.textContent = t('操作未完成，请检查状态后重试') + ' [' + error.message + ']'; } finally { node.disabled = false; } }; return node; };
        if (options.edit) actions.append(action('编辑', async () => { await recordDialog(message, true); close(); }));
        actions.append(action('历史', async () => { await recordDialog(message, false); close(); }), action('下载', () => exportRecord(message, false)), action('存到网盘', () => exportRecord(message, true)));
        const retry = action('重试', () => load()); retry.hidden = true;
        header.append(title, dismiss); panel.append(header, loading, content, status, retry, actions); layer.append(panel); document.body.append(layer); document.addEventListener('keydown', escape, true);
        layer.addEventListener('click', event => { if (event.target === layer) close(); });
        async function load() {
            content.hidden = true; content.replaceChildren(); loading.hidden = false; content.setAttribute('aria-busy', 'true'); status.textContent = ''; retry.hidden = true;
            resolved?.close(); resolved = undefined;
            try {
                if (refs(message.markdown).length) resolved = await resolve(message.markdown);
                if (!layer.isConnected) { resolved?.close(); return; }
                render(content, message.markdown, resolved?.mapping, { onInvitation: close });
                await waitForImages(content, controller.signal);
            } catch (error) {
                if (!layer.isConnected) return;
                if (!content.childNodes.length) render(content, message.markdown, undefined, { onInvitation: close });
                status.textContent = t('部分引用资源不可读取，可检查来源后重试') + ' [' + error.message + ']'; retry.hidden = false;
            } finally {
                if (layer.isConnected) { content.hidden = false; loading.hidden = true; content.setAttribute('aria-busy', 'false'); }
            }
        }
        await load();
    }
    function waitForImages(target, signal) {
        return Promise.all([...target.querySelectorAll('img[src]')].map(image => new Promise((resolve, reject) => {
            if (image.complete) return image.naturalWidth ? resolve() : reject(Error('STREAM_IMAGE_UNAVAILABLE'));
            const finish = error => { clearTimeout(timer); image.removeEventListener('load', loaded); image.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
            const loaded = () => finish(), failed = () => finish(Error('STREAM_IMAGE_UNAVAILABLE')), aborted = () => finish(Error('STREAM_PREVIEW_CANCELLED'));
            const timer = setTimeout(() => finish(Error('STREAM_IMAGE_TIMEOUT')), 15000);
            image.addEventListener('load', loaded, { once: true }); image.addEventListener('error', failed, { once: true }); signal.addEventListener('abort', aborted, { once: true });
            if (signal.aborted) aborted();
        })));
    }
    function render(target, body, mapping = new Map(), { onInvitation } = {}) {
        target.classList?.toggle('sc-markdown-plain', !global.marked || !global.DOMPurify);
        if (!global.marked || !global.DOMPurify) { target.textContent = body; return; }
        let source = String(body); const placeholders = new Map();
        for (const [from, to] of mapping) {
            const placeholder = '#stream-reference-' + placeholders.size;
            placeholders.set(placeholder, to); source = source.split(from).join(placeholder);
        }
        target.innerHTML = global.DOMPurify.sanitize(global.marked.parse(source, { breaks: true }), {
            FORBID_TAGS: ['iframe', 'object', 'embed', 'style', 'form', 'input', 'script'], FORBID_ATTR: ['style', 'srcset']
        });
        // Purify intentionally strips blob: URLs. Resolve only the explicitly
        // granted placeholders after sanitizing all user-authored HTML.
        target.querySelectorAll('[src],[href]').forEach(node => {
            for (const attribute of ['src', 'href']) {
                const value = placeholders.get(node.getAttribute(attribute));
                if (value) node.setAttribute(attribute, value);
            }
        });
        const urls = new Set(mapping.values());
        target.querySelectorAll('img,audio,video,source').forEach(node => {
            if (!urls.has(node.getAttribute('src'))) { node.removeAttribute('src'); node.setAttribute('aria-label', t('引用资源未获准或已失效')); node.setAttribute('title', t('引用资源未获准或已失效')); if (node.tagName === 'IMG') node.alt = (node.alt ? node.alt + ' · ' : '') + t('引用资源未获准或已失效'); }
            if (node.matches('audio,video')) node.controls = true;
        });
        target.querySelectorAll('a').forEach(node => {
            const href = node.getAttribute('href') || '';
            if (!/^(https?:\/\/|\/\?stream(?:_invite)?=|#)/.test(href) && !urls.has(href)) node.removeAttribute('href');
            node.rel = 'noopener noreferrer';
            node.addEventListener('click', event => {
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                const href = node.getAttribute('href'); if (!href) return;
                let url; try { url = new URL(href, location.href); } catch (_) { return; }
                if (url.origin !== location.origin || !url.searchParams.has('stream_invite')) return;
                event.preventDefault();
                if (!global.StreamingConsole?.openInvitation) return;
                Promise.resolve(global.StreamingConsole.openInvitation(url.searchParams.get('stream_invite'))).then(opened => { if (opened !== false) onInvitation?.(); });
            });
        });
    }
    async function resolve(body) {
        const mapping = new Map(), blobs = [];
        try {
            if (refs(body).length > 100) throw Error('STREAM_REFERENCE_LIMIT');
            let bytes = 0;
            for (const url of refs(body)) {
                const blob = await options.readReference(url, { maxBytes: 256 * 1024 * 1024 - bytes }); bytes += blob.size;
                if (bytes > 256 * 1024 * 1024) throw Error('STREAM_REFERENCE_LIMIT');
                const objectUrl = URL.createObjectURL(blob); mapping.set(url, objectUrl); blobs.push({ url, blob });
            }
        } catch (error) { mapping.forEach(value => URL.revokeObjectURL(value)); throw error; }
        return { mapping, blobs, close() { mapping.forEach(value => URL.revokeObjectURL(value)); } };
    }
    async function archive(message) {
        if (!refs(message.markdown).length) return new File([message.markdown], 'markdown-' + message.id + '.md', { type: 'text/markdown' });
        const resolved = await resolve(message.markdown);
        try {
            let body = message.markdown;
            const files = resolved.blobs.map(({ url, blob }, index) => {
                const name = 'resources/' + String(index + 1) + '-' + (options.referenceName?.(url) || 'resource');
                body = body.split(url).join(name);
                return new File([blob], name, { type: blob.type });
            });
            files.unshift(new File([body], 'message.md', { type: 'text/markdown' }));
            return new File([await global.FolderArchive.createZip(files)], 'markdown-' + message.id + '.zip', { type: 'application/zip' });
        } finally { resolved.close(); }
    }
    function mount(target, message) {
        const wrapper = document.createElement('div'); wrapper.className = 'tunnel-markdown';
        const preview = document.createElement('div'); preview.className = 'tunnel-markdown-preview message-content'; render(preview, message.markdown);
        const status = document.createElement('p'); status.className = 'sc-message-status';
        const actions = document.createElement('div'); actions.className = 'sc-actions';
        const expand = document.createElement('button'); expand.type = 'button'; expand.className = 'sc-markdown-expand'; expand.textContent = t('展开');
        const collapsible = String(message.markdown || '').replace(/\r\n?/g, '\n').trimEnd().split('\n').length > 10;
        let expanded = false; preview.classList.toggle('collapsible', collapsible); expand.hidden = !collapsible;
        expand.onclick = event => { event.stopPropagation(); expanded = !expanded; preview.classList.toggle('expanded', expanded); expand.textContent = t(expanded ? '收起' : '展开'); };
        actions.append(expand);
        if (message.purpose === 'stream-invitation') {
            const purpose = document.createElement('strong'); purpose.textContent = t('串流邀请'); wrapper.append(purpose);
            if (/^data:image\/(?:png|jpeg|webp);base64,/.test(message.thumbnail || '') && message.thumbnail.length <= 90000) { const image = document.createElement('img'); image.className = 'sc-invite-thumbnail'; image.alt = t('邀请缩略图'); image.src = message.thumbnail; wrapper.append(image); }
        }
        wrapper.append(preview, actions, status); target.append(wrapper);
        if (refs(message.markdown).length) resolve(message.markdown).then(result => {
            if (!target.isConnected) { result.close(); return; }
            render(preview, message.markdown, result.mapping);
            const observer = new MutationObserver(() => { if (!target.isConnected) { result.close(); observer.disconnect(); } }); observer.observe(document.body, { childList: true, subtree: true });
        }).catch(() => { status.textContent = t('部分引用资源不可读取，可检查来源后重试'); });
    }
    function menuActions(message) {
        const actions = [];
        const add = (label, run) => { const action = document.createElement('button'); action.type = 'button'; action.textContent = t(label); action.onclick = async event => { event.stopPropagation(); action.disabled = true; try { await run(); } catch (error) { global.alert(t('操作未完成，请检查状态后重试') + ' [' + error.message + ']'); } finally { action.disabled = false; } }; actions.push(action); };
        add('保存到网盘', () => exportRecord(message, true));
        return actions;
    }
    async function exportRecord(message, upload) {
        const file = await archive(message);
        if (upload) { try { await options.upload(file); } catch (_) { /* Drive task UI owns upload outcomes, including cancellation. */ } }
        else { const url = URL.createObjectURL(file), link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    }
    function init(config) { options = config; }
    global.TunnelMarkdown = { init, render, refs, archive, mount, fromHtml, menuActions, save: message => exportRecord(message, true), preview: previewRecord };
})(window);
