'use strict';
// Back-office authentication authorizes configuration, not a front-office role.
function mountTunnelPermissionRoutes(app, { requireAuth, get, save, validSessionId }) {
    app.get('/api/sessions/:sessionId/access', requireAuth, (req, res) => {
        if (!validSessionId(req.params.sessionId)) return res.status(400).json({ error: 'invalid-session' });
        const access = get(req.params.sessionId);
        if (!access) return res.status(404).json({ error: 'session-not-found' });
        res.json(access);
    });
    app.put('/api/sessions/:sessionId/access', requireAuth, (req, res) => {
        if (!validSessionId(req.params.sessionId)) return res.status(400).json({ error: 'invalid-session' });
        if (!get(req.params.sessionId)) return res.status(404).json({ error: 'session-not-found' });
        try { res.json({ ok: true, ...save(req.params.sessionId, req.body || {}) }); }
        catch (error) { res.status(400).json({ error: error.message || 'invalid-permissions' }); }
    });
}
module.exports = { mountTunnelPermissionRoutes };
