'use strict';
const crypto = require('node:crypto');
const { mediaKind } = require('./streaming-console');
const references = body => [...String(body).matchAll(/tunnel-blob:([\w-]+)\/([\w.-]+)\/([\w.-]+)/g)];
function createStreamingTunnels({ session, messages, admitted, capability, publish, mapDevices = values => values }) {
    const deny = code => { throw new Error(code); };
    function memberId(input, actor) {
        let memberId = input.tunnelDeviceId || actor.deviceId;
        if (!input.tunnelDeviceId && input.accessGrant) { try { memberId = JSON.parse(Buffer.from(input.accessGrant.split('.')[0], 'base64url').toString()).deviceId || memberId; } catch (_) {} }
        return memberId;
    }
    function authorize(input, actor, operation = 'read') {
        const member = memberId(input, actor);
        if (!admitted(input.sessionId, member, input.accessGrant)) deny('STREAM_TUNNEL_DENIED');
        const current = session(input.sessionId);
        if (!current || !capability(current, member, operation)) deny('STREAM_TUNNEL_DENIED');
        return current;
    }
    function stat(source) {
        if (source.authorizedDeviceId && !capability(session(source.sessionId), source.authorizedDeviceId, 'read')) deny('STREAM_SOURCE_REVOKED');
        const entry = messages(source.sessionId).find(message => message.id === source.messageId);
        if (source.fileId === 'record' && entry && ['markdown', 'text'].includes(entry.type)) {
            const inline = Buffer.from(entry.type === 'markdown' ? entry.markdown : entry.text || '', 'utf8');
            return { name: (entry.type === 'markdown' ? 'message.md' : 'message.txt'), type: entry.type === 'markdown' ? 'text/markdown' : 'text/plain', size: inline.length, inline };
        }
        const file = entry?.type === 'file' ? entry.fileInfo?.id === source.fileId && entry.fileInfo
            : entry?.collection?.files?.find(file => file.id === source.fileId);
        if (!file) deny('STREAM_SOURCE_DELETED');
        let inline;
        if (typeof file.data === 'string' && /^data:[^,]*;base64,/.test(file.data)) inline = Buffer.from(file.data.slice(file.data.indexOf(',') + 1), 'base64');
        if (inline && inline.length !== Number(file.size)) inline = null;
        return { name: file.name, type: file.type || '', size: Number(file.size), inline };
    }
    function resolve(input, actor) {
        authorize(input, actor);
        const source = { kind: 'tunnel', sessionId: String(input.sessionId), messageId: String(input.messageId), fileId: String(input.fileId), authorizedDeviceId: memberId(input, actor) };
        return { source, ...stat(source), inline: undefined };
    }
    function candidates(input, actor, allFiles = false) {
        authorize(input, actor);
        const result = [];
        for (const message of messages(input.sessionId)) {
            if (['markdown', 'text'].includes(message.type)) {
                const metadata = stat({ sessionId: input.sessionId, messageId: message.id, fileId: 'record' });
                result.push({ name: metadata.name, type: metadata.type, size: metadata.size, kind: message.type === 'markdown' ? 'markdown' : 'text', recordName: message.id,
                    source: { kind: 'tunnel', sessionId: input.sessionId, messageId: message.id, fileId: 'record', accessGrant: input.accessGrant } });
            }
            for (const file of message.type === 'file' ? [message.fileInfo] : message.collection?.files || []) {
                if (!file?.id) continue;
                try {
                    let kind; try { kind = mediaKind(file.name, file.type); } catch (error) { if (!allFiles) throw error; kind = 'file'; }
                    result.push({ name: file.name, type: file.type, size: Number(file.size), kind, recordName: message.remark || message.id,
                        source: { kind: 'tunnel', sessionId: input.sessionId, messageId: message.id, fileId: file.id, accessGrant: input.accessGrant } });
                } catch (_) { /* Non-preview files stay outside the station list. */ }
            }
        }
        return { candidates: result.slice(-1000) };
    }
    let service;
    function send(input, actor) {
        const current = authorize(input, actor, 'sendText');
        let body = String(input.body || '').trim(), purpose = null, thumbnail = null;
        if (input.inviteToken) {
            const { station } = service.inspectInvite(input.inviteToken, actor);
            if (!service.invitations(station.id, actor).some(invite => invite.token === input.inviteToken && !['revoked', 'expired'].includes(invite.status))) deny('STREAM_INVITE_INVALID');
            body = `串流邀请 · ${station.name.replace(/[\r\n[\]()*_!<>]/g, ' ')}\n\n[打开邀请](/?stream_invite=${encodeURIComponent(input.inviteToken)})`;
            purpose = 'stream-invitation';
            thumbnail = service.inspectInvite(input.inviteToken, actor).thumbnail;
        }
        if (!body || body.length > 200000) deny('STREAM_MESSAGE_INVALID');
        if (references(body).length > 100) deny('STREAM_REFERENCE_LIMIT');
        for (const ref of references(body)) resolve({ sessionId: ref[1], messageId: ref[2], fileId: ref[3], accessGrant: input.tunnelGrants?.[ref[1]] }, actor);
        // Stable client submission ID gives retries the same history identity.
        const messageId = String(input.messageId || '');
        if (!/^[\w-]{8,100}$/.test(messageId)) deny('STREAM_MESSAGE_INVALID');
        const existing = messages(input.sessionId).find(message => message.id === messageId);
        if (existing) {
            if (existing.sender !== actor.deviceId || existing.markdown !== body) deny('STREAM_CONFLICT');
            if (input.inviteToken) service.markInviteSent(input.inviteToken, actor);
            return { ok: true, messageId, message: existing, duplicate: true };
        }
        const message = { id: messageId, type: 'markdown', markdown: body, purpose, thumbnail,
            timestamp: Date.now(), sender: actor.deviceId, senderName: String(input.deviceName || actor.deviceId).replace(/[<>]/g, '').slice(0, 100) };
        publish(input.sessionId, current, message, actor.deviceId);
        if (input.inviteToken) service.markInviteSent(input.inviteToken, actor);
        return { ok: true, messageId, message };
    }
    return { resolve, stat, candidates, resources: (input, actor) => candidates(input, actor, true), send, references, bind(value) { service = value; },
        alias(input, actor) { authorize(input, actor); return memberId(input, actor); },
        providers: source => { const values = [...new Set([...(session(source.sessionId)?.fileAssets?.get(source.fileId)?.providers || []),
            ...(session(source.sessionId)?.devices?.keys() || [])])]; return [...new Set([...values, ...mapDevices(values)])]; } };
}
module.exports = { createStreamingTunnels };
