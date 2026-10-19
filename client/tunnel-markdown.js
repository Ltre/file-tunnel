(function (global) {
    'use strict';
    const refs = body => [...new Set([...String(body).matchAll(/tunnel-blob:([\w-]+)\/([\w.-]+)\/([\w.-]+)/g)].map(match => match[0]))];
    const t = value => global.TunnelI18n?.t(value) || value;
    let options = {};
    function render(target, body, mapping = new Map()) {
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
        const expand = document.createElement('button'); expand.type = 'button'; expand.textContent = t('展开 Markdown');
        let expanded = false;
        expand.onclick = () => { expanded = !expanded; preview.classList.toggle('expanded', expanded); expand.textContent = t(expanded ? '收起 Markdown' : '展开 Markdown'); };
        actions.append(expand);
        if (message.purpose === 'stream-invitation') {
            const purpose = document.createElement('strong'); purpose.textContent = t('串流邀请'); wrapper.append(purpose);
            if (/^data:image\/(?:png|jpeg|webp);base64,/.test(message.thumbnail || '') && message.thumbnail.length <= 90000) { const image = document.createElement('img'); image.className = 'sc-invite-thumbnail'; image.alt = t('邀请缩略图'); image.src = message.thumbnail; wrapper.append(image); }
        } else {
            for (const [label, upload] of [['下载', false], ['上传到网盘', true]]) {
                const b = document.createElement('button'); b.type = 'button'; b.textContent = t(label);
                b.onclick = async () => {
                    b.disabled = true; status.textContent = t('正在打包 Markdown 及引用资源');
                    try {
                        const zip = await archive(message);
                        if (upload) await options.upload(zip);
                        else { const url = URL.createObjectURL(zip), link = document.createElement('a'); link.href = url; link.download = zip.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
                        status.textContent = t(upload ? '已上传到网盘' : '已发起下载');
                    } catch (error) { status.textContent = t('打包或保存失败，请检查引用资源后重试') + ' [' + error.message + ']'; }
                    finally { b.disabled = false; }
                }; actions.append(b);
            }
        }
        wrapper.append(preview, actions, status); target.append(wrapper);
        if (refs(message.markdown).length) resolve(message.markdown).then(result => {
            if (!target.isConnected) { result.close(); return; }
            render(preview, message.markdown, result.mapping);
            const observer = new MutationObserver(() => { if (!target.isConnected) { result.close(); observer.disconnect(); } }); observer.observe(document.body, { childList: true, subtree: true });
        }).catch(() => { status.textContent = t('部分引用资源不可读取，可检查来源后重试'); });
    }
    function init(config) { options = config; }
    global.TunnelMarkdown = { init, render, refs, archive, mount };
})(window);
