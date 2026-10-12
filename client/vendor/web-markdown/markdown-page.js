/* Drop2Tunnel Markdown page support v1. Bundled into the ZIP; no CDN required. */
(function () {
    'use strict';
    const source = document.querySelector('[data-markdown-source]');
    const output = document.querySelector('[data-markdown-content]');
    if (!source || !output) return;
    function resourceUrl(value, base) {
        const reference = String(value || '').trim();
        if (!reference || reference.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) return reference;
        return new URL(reference, base).href;
    }
    async function render() {
        try {
            if (!window.marked || !window.DOMPurify) throw new Error('Markdown 支持资源缺失，请检查 ZIP 中的 assets 目录');
            const url = new URL(source.getAttribute('href'), location.href);
            const response = await fetch(url, { cache:'no-store' });
            if (!response.ok) throw new Error('Markdown 文件读取失败（HTTP '+response.status+'）');
            const parsed = window.marked.parse(await response.text(), { gfm:true, breaks:false, async:false });
            const fragment = window.DOMPurify.sanitize(parsed, { USE_PROFILES:{html:true}, RETURN_DOM_FRAGMENT:true });
            for (const element of fragment.querySelectorAll('[href],[src],[poster],[srcset]')) {
                for (const attribute of ['href','src','poster']) {
                    if (element.hasAttribute(attribute)) element.setAttribute(attribute, resourceUrl(element.getAttribute(attribute),url));
                }
                // Let ordinary src load instead of guessing the boundaries of a
                // complex srcset (commas in file names and data URLs are legal).
                if (element.hasAttribute('srcset')) element.removeAttribute('srcset');
                if (element.tagName === 'A' && element.getAttribute('target') === '_blank') element.setAttribute('rel','noopener noreferrer');
            }
            output.replaceChildren(fragment);
            output.removeAttribute('aria-busy');
            const heading = output.querySelector('h1');
            if (heading?.textContent) document.title = heading.textContent;
        } catch (error) {
            output.textContent = '无法显示 Markdown：'+(error.message || String(error));
            output.removeAttribute('aria-busy');
            output.classList.add('markdown-error');
        }
    }
    render();
})();
