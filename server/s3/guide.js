'use strict';

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
function safeLink(value) {
    const target = value.replace(/^<|>$/g, '').trim();
    if (target.startsWith('#')) return target;
    try {
        const url = new URL(target, 'https://guide.invalid/docs/telegram-drive-s3-compatible.md');
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        return url.origin === 'https://guide.invalid' ? url.pathname + url.search + url.hash : url.href;
    } catch (_) { return null; }
}
function inline(text) {
    const pattern = /`([^`\n]*)`|\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)|\*\*([^*\n]+)\*\*/g;
    let html = '', from = 0, match;
    while ((match = pattern.exec(text))) {
        html += escapeHtml(text.slice(from, match.index));
        if (match[1] !== undefined) html += `<code>${escapeHtml(match[1])}</code>`;
        else if (match[2] !== undefined) {
            const link = safeLink(match[3]);
            html += link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[2])}</a>` : escapeHtml(match[2]);
        } else html += `<strong>${escapeHtml(match[4])}</strong>`;
        from = pattern.lastIndex;
    }
    return html + escapeHtml(text.slice(from));
}
function renderMarkdown(markdown) {
    // This guide only needs headings, paragraphs, lists, tables and code fences.
    // Raw HTML is always text; links only use HTTP(S) or same-origin paths.
    const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n'), output = [];
    const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
    for (let index = 0; index < lines.length;) {
        const line = lines[index];
        if (!line.trim()) { index++; continue; }
        const fence = /^\s*(`{3,}|~{3,})(\w*)\s*$/.exec(line);
        if (fence) {
            const content = [], marker = fence[1]; index++;
            while (index < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[index])) content.push(lines[index++]);
            if (index < lines.length) index++;
            output.push(`<pre><code>${escapeHtml(content.join('\n'))}</code></pre>`); continue;
        }
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        if (heading) { output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); index++; continue; }
        if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] || '')) {
            const headings = cells(line), rows = []; index += 2;
            while (index < lines.length && /^\s*\|/.test(lines[index])) rows.push(cells(lines[index++]));
            output.push(`<div class="table-wrap"><table><thead><tr>${headings.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headings.map((_, at) => `<td>${inline(row[at] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
        }
        if (/^\s*[-*]\s+/.test(line)) {
            const items = [];
            while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) items.push(inline(lines[index++].replace(/^\s*[-*]\s+/, '')));
            output.push(`<ul>${items.map(item => `<li>${item}</li>`).join('')}</ul>`); continue;
        }
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { output.push('<hr>'); index++; continue; }
        const paragraph = [line]; index++;
        while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s|\s*[-*]\s|\s*\||\s*`{3,}|\s*~{3,})/.test(lines[index])) paragraph.push(lines[index++]);
        output.push(`<p>${inline(paragraph.join(' '))}</p>`);
    }
    return output.join('\n');
}
function guidePage(markdown) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Telegram 网盘 S3 接入手册</title><style>*{box-sizing:border-box}body{margin:0;background:#eef3f7;color:#243746;font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif}header{background:#173a51;color:white;padding:15px 22px;display:flex;align-items:center;gap:18px}header a{color:white;text-decoration:none;border:1px solid #ffffff66;border-radius:7px;padding:6px 12px}main{max-width:1040px;margin:20px auto;padding:24px;background:white;border:1px solid #d4dfe7;border-radius:12px}h1{font-size:26px}h2{margin-top:30px;border-bottom:1px solid #e2e8ee;padding-bottom:8px;font-size:21px}h3{font-size:18px}a{color:#176890}code{padding:2px 5px;background:#edf3f7;border-radius:4px;overflow-wrap:anywhere}pre{overflow:auto;padding:14px;background:#edf3f7;border-radius:8px}pre code{padding:0;white-space:pre}li{margin:7px 0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:10px 12px;border:1px solid #dce5ec;text-align:left}th{background:#f1f6f9}p{overflow-wrap:anywhere}@media(max-width:600px){header{padding:12px;flex-wrap:wrap}main{margin:10px;padding:15px}h1{font-size:22px}}</style></head><body><header><a href="/s3-management">← S3 接入管理</a><span>接入手册 · 文档更新自动生效</span></header><main>${renderMarkdown(markdown)}</main></body></html>`;
}
module.exports = { renderMarkdown, guidePage };
