'use strict';
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
module.exports = { editMarkdownRecord, recoverMarkdownRecord };
