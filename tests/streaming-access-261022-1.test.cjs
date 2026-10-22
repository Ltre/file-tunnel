'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createStreamingConsole, mediaKind } = require('../server/streaming-console');
const { createStreamingTunnels } = require('../server/streaming-tunnels');
function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-access-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const service = createStreamingConsole({ dataDir, user: id => ({ id }), visibleDevices: () => ['B', 'C'], sources: { resolve: async source => ({ source, name: 'a.png', type: 'image/png', size: 1 }) } });
    for (const id of ['A', 'B', 'C']) service.register(id, id.repeat(40), id);
    const a = { deviceId: 'A', userId: 'owner', logins: [{ id: 'owner', hash: 'hash', expiresAt: Date.now() + 600000 }] };
    const s = service.create(a, {}); service.visibility(s.id, a, { visibility: 'public', version: 1 });
    return { service, a, s, b: { deviceId: 'B', userId: 'viewer' }, c: { deviceId: 'C', userId: 'viewer' } };
}
test('concrete MIME takes priority over a misleading media extension in current source metadata', () => {
    assert.equal(mediaKind('replaced.m4a', 'image/png'), 'image');
    assert.equal(mediaKind('replaced.m4a', 'text/plain'), 'text');
    assert.throws(() => mediaKind('replaced.m4a', 'application/pdf'), /TYPE_UNSUPPORTED/);
    assert.equal(mediaKind('unknown.mp3', 'application/octet-stream'), 'audio');
});
test('tunnel aliases use the verified grant member when older stored authorizations omit its ID', () => {
    const grant = Buffer.from(JSON.stringify({ deviceId: 'tunnel-member' })).toString('base64url') + '.signature';
    const tunnel = createStreamingTunnels({ admitted: (_s, id) => id === 'tunnel-member', capability: () => true, session: () => ({}), messages: () => [] });
    assert.equal(tunnel.alias({ sessionId: 'tunnel', accessGrant: grant }, { deviceId: 'root-device' }), 'tunnel-member');
});
test('general invite is generated, only explicit forwarding marks it sent, and revoke removes its list record', t => {
    const f = fixture(t), invite = f.service.invitation(f.s.id, f.a, {});
    assert.equal(invite.status, 'generated');
    f.service.markInviteSent(invite.token, f.a);
    assert.equal(f.service.invitations(f.s.id, f.a)[0].status, 'sent');
    f.service.revoke(f.s.id, f.a, invite.id);
    assert.equal(f.service.invitations(f.s.id, f.a).length, 0);
    assert.throws(() => f.service.inspectInvite(invite.token, f.b), /REVOKED|INVALID/);
});
test('account blacklist denies every device for this account but is isolated by station and supports unblock', async t => {
    const f = fixture(t); await f.service.edit(f.s.id, f.a, { configVersion: 1, items: [{ id: 'one', source: { kind: 'local', fileId: 'file' } }] });
    const other = f.service.create(f.a, {}); f.service.visibility(other.id, f.a, { visibility: 'public', version: 1 });
    f.service.access(f.s.id, f.a, 'viewer', false, 'user');
    for (const viewer of [f.b, f.c]) {
        assert.throws(() => f.service.view(f.s.id, viewer), /KICKED/);
        await assert.rejects(f.service.resource(f.s.id, 'one', viewer), /KICKED/);
        assert.equal(f.service.view(other.id, viewer).id, other.id);
    }
    assert.equal(f.service.view(f.s.id, f.a, { manage: true }).blockedUsers[0], 'viewer');
    f.service.access(f.s.id, f.a, 'viewer', true, 'user'); assert.equal(f.service.view(f.s.id, f.b).id, f.s.id);
});
