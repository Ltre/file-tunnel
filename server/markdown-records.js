'use strict';
const fs = require('node:fs/promises');
// Versioned Markdown records share the tunnel's existing history and ACLs.
function editMarkdownRecord(message, { content, baseVersion, deviceId, deviceName, now = Date.now(), maxBytes }) {
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > maxBytes) return { ok: false, error: 'content-too-large' };
    const version = Number(message.markdownVersion) || 1;
    if (Number(baseVersion) !== version) return { ok: false, conflict: true, message };
    if (content === message.markdown) return { ok: true, message };
    const versions = new Map((Array.isArray(message.markdownHistory) ? message.markdownHistory : []).filter(item => item && typeof item.content === 'string' && Number.isSafeInteger(item.version) && item.version > 0 && item.version <= version).map(item => [item.version, item]));
    if (versions.get(version)?.content !== message.markdown) versions.set(version, { version, content: message.markdown, editorDeviceId: message.sender, editorDeviceName: message.senderName, editedAt: message.timestamp });
    const history = [...versions.values()].sort((a, b) => a.version - b.version);
    const updated = { ...message, markdown: content, markdownVersion: version + 1,
        markdownHistory: [...history, { version: version + 1, content, editorDeviceId: deviceId, editorDeviceName: deviceName, editedAt: now }],
        updatedAt: now, updatedBy: deviceId };
    return { ok: true, message: updated };
}
function recoverMarkdownRecord(previous, incoming) {
    const version = Number(previous.markdownVersion) || 1, next = Number(incoming.markdownVersion), history = incoming.markdownHistory;
    if (previous.type !== 'markdown' || incoming.type !== 'markdown' || previous.id !== incoming.id || previous.sender !== incoming.sender || previous.timestamp !== incoming.timestamp ||
        !Number.isSafeInteger(next) || next <= version || !Array.isArray(history) || history.length !== next || typeof incoming.markdown !== 'string') return null;
    if (!history.every((entry, index) => entry && entry.version === index + 1 && typeof entry.content === 'string') || history.at(-1).content !== incoming.markdown || history[version - 1].content !== previous.markdown) return null;
    for (const known of Array.isArray(previous.markdownHistory) ? previous.markdownHistory : []) if (history[known.version - 1]?.content !== known.content) return null;
    return { ...previous, markdown: incoming.markdown, markdownVersion: next,
        markdownHistory: history.map(({ version, content, editorDeviceId, editorDeviceName, editedAt }) => ({ version, content, editorDeviceId, editorDeviceName, editedAt })),
        updatedAt: incoming.updatedAt, updatedBy: incoming.updatedBy };
}
function mountMarkdownReferenceRoute(app, { canRead, file, serverAsset }) {
    app.post('/api/tunnel-markdown/reference', async (req, res, next) => {
        res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        const { sessionId, messageId, fileId, deviceId, grant, maxBytes } = req.body || {};
        if (![messageId, fileId].every(value => typeof value === 'string' && /^[\w.-]{1,128}$/.test(value)) ||
            !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
            return res.status(400).json({ error: 'TUNNEL_REFERENCE_INVALID' });
        }
        try {
            if (!canRead(sessionId, deviceId, grant)) return res.status(403).json({ error: 'TUNNEL_REFERENCE_DENIED' });
            const info = file(sessionId, messageId, fileId);
            if (info?.id !== fileId) return res.status(404).json({ error: 'TUNNEL_REFERENCE_MISSING' });
            const size = Number(info.size);
            if (!Number.isSafeInteger(size) || size < 0 || size > Math.min(maxBytes, 256 * 1024 * 1024)) {
                return res.status(413).json({ error: 'TUNNEL_REFERENCE_LIMIT' });
            }
            const type = String(info.type || '').toLowerCase();
            const mime = /^(image|audio|video)\//.test(type) && !type.startsWith('image/svg+xml') ? type : 'text/plain; charset=utf-8';
            const sendHeaders = () => res.set({ 'Content-Type': mime, 'X-Tunnel-Reference-Name': encodeURIComponent(info.name || fileId) });
            if (typeof info.data === 'string' && /^data:[^,]*;base64,/.test(info.data)) {
                const bytes = Buffer.from(info.data.slice(info.data.indexOf(',') + 1), 'base64');
                if (bytes.length === size) return sendHeaders().send(bytes);
            }
            if (info.isServerAsset && info.serverAssetUrl === '/api/server-assets/' + fileId) {
                const asset = serverAsset(fileId);
                if (asset?.sessionId === sessionId && Number(asset.size) === size) {
                    const stat = await fs.stat(asset.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
                    if (stat?.isFile() && stat.size === size) {
                        if (!canRead(sessionId, deviceId, grant)) return res.status(403).json({ error: 'TUNNEL_REFERENCE_DENIED' });
                        if (file(sessionId, messageId, fileId)?.id !== fileId) return res.status(404).json({ error: 'TUNNEL_REFERENCE_MISSING' });
                        return sendHeaders().sendFile(asset.path, { cacheControl: false }, error => {
                            if (!error) return;
                            if (error.code === 'ENOENT' && !res.headersSent) return res.status(404).json({ error: 'TUNNEL_REFERENCE_MISSING' });
                            next(error);
                        });
                    }
                }
            }
            return res.status(404).json({ error: 'TUNNEL_REFERENCE_MISSING' });
        } catch (error) { next(error); }
    });
}
module.exports = { editMarkdownRecord, recoverMarkdownRecord, mountMarkdownReferenceRoute };
