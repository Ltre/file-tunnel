'use strict';
const crypto = require('node:crypto');

// Keep the established cookie name and URL paths for existing browsers. Account
// proof, identity selection and external application bindings are host adapters.
const FLOW_COOKIE = '__Host-disk_passkey_flow', COOKIE_PATH = '/';
const cookieOptions = () => ({ httpOnly: true, secure: true, sameSite: 'lax', path: COOKIE_PATH });
const binding = req => String(req.headers.cookie || '').split(';').map(value => value.trim())
    .find(value => value.startsWith(FLOW_COOKIE + '='))?.slice(FLOW_COOKIE.length + 1) || '';
function issue(req, res, reuse = true) {
    const value = reuse && binding(req) || crypto.randomBytes(32).toString('base64url');
    res.cookie(FLOW_COOKIE, value, { ...cookieOptions(), maxAge: 300000 });
    return value;
}

function installPasskeyAuthenticationRoutes(router, { auth, getIdentity = () => null,
    getSessionProof = () => '', getOrigin, limiter, wrap, isMockRequest = () => false,
    issueBinding = () => crypto.randomBytes(32).toString('base64url'), readBinding = binding,
    afterOptions = () => {}, afterVerify = () => {}, allowExisting = false }) {
    router.post('/passkeys/:kind/options', limiter(), wrap(async (req, res) => {
        if (isMockRequest(req)) throw new Error('LOCAL_USE_OIDC_MOCK');
        const current = req.body?.addAccount === true ? null : getIdentity(req);
        const origin = getOrigin(req);
        if (req.params.kind === 'register' && current)
            auth.requireRecentAuthentication(current.id, getSessionProof(req), origin);
        const flowBinding = issueBinding(req, res);
        const result = await auth.passkeyOptions({ kind: req.params.kind, username: req.body?.username,
            existingUserId: current?.id || '', origin, binding: flowBinding,
            rpID: req.body?.rpID, allowExisting });
        afterOptions(req, res, flowBinding);
        res.json(result);
    }));
    router.post('/passkeys/verify', limiter(), wrap(async (req, res) => {
        if (isMockRequest(req)) throw new Error('LOCAL_USE_OIDC_MOCK');
        const current = req.body?.addAccount === true ? null : getIdentity(req);
        const origin = getOrigin(req);
        const identity = await auth.passkeyVerify({ flowId: req.body?.flow_id, response: req.body?.response,
            binding: readBinding(req), existingUserId: current?.id || '', origin });
        afterVerify(req, res, identity, origin);
        res.json({ identity, user_id: identity.id, authenticatedRpID: identity.authenticatedRpID });
    }));
}

function installPasskeyRoutes(router, { auth, getIdentity, setIdentity, getSessionProof,
    getOrigin, limiter, wrap, isMockRequest }) {
    const csrf = (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (req.method !== 'GET' && (!req.is('application/json') || req.get('Sec-Fetch-Site') === 'cross-site' ||
            req.get('Origin') && req.get('Origin') !== getOrigin(req))) return res.status(403).json({ error: 'ORIGIN_MISMATCH' });
        next();
    };
    router.use('/passkeys', csrf);
    const identity = req => { const user = getIdentity(req); if (!user) throw Error('LOGIN_REQUIRED'); return user; };
    router.get('/passkeys', wrap((req, res) => {
        const user = identity(req);
        res.json({ identity: user, passkeys: auth.passkeys(user.id), origins: auth.passkeyOrigins() });
    }));
    router.patch('/passkeys/:id', limiter(), wrap((req, res) => {
        const user = identity(req);
        auth.requireRecentAuthentication(user.id, getSessionProof(req), getOrigin(req));
        res.json({ passkey: auth.renamePasskey(user.id, req.params.id, req.body?.remark) });
    }));
    router.post('/passkeys/choices', limiter(), wrap((req, res) => res.json(auth.passkeyChoices({ username: req.body?.username, origin: getOrigin(req) }))));
    router.post('/passkeys/handoff/start', limiter(), wrap((req, res) => res.json(auth.startHandoff({ username: req.body?.username, rpID: req.body?.rpID, origin: getOrigin(req), binding: issue(req, res), returnPath: req.body?.returnPath || '/' }))));
    router.get('/passkeys/handoff/info', limiter(), wrap((req, res) => res.json(auth.handoffInfo(req.query.flow, getOrigin(req)))));
    router.post('/passkeys/handoff/cancel', wrap((req, res) => { auth.cancelHandoff({ id: req.body?.flow, origin: getOrigin(req), binding: binding(req) }); res.json({ ok: true }); }));
    router.post('/passkeys/handoff/options', limiter(), wrap(async (req, res) => res.json(await auth.handoffOptions({ id: req.body?.flow, origin: getOrigin(req), binding: issue(req, res) }))));
    router.post('/passkeys/handoff/verify', limiter(), wrap(async (req, res) => res.json(await auth.handoffVerify({ flowId: req.body?.flow_id, response: req.body?.response, origin: getOrigin(req), binding: binding(req) }))));
    router.post('/passkeys/handoff/complete', limiter(), wrap((req, res) => {
        const result = auth.completeHandoff({ id: req.body?.flow, code: req.body?.code, origin: getOrigin(req), binding: binding(req) });
        setIdentity(req, res, result.identity);
        auth.rememberAuthentication(result.identity.id, getSessionProof(req), getOrigin(req));
        res.json(result);
    }));
    installPasskeyAuthenticationRoutes(router, { auth, getIdentity, getSessionProof, getOrigin, limiter, wrap,
        isMockRequest, allowExisting: true,
        afterOptions(req, res, flowBinding) {
            res.cookie(FLOW_COOKIE, flowBinding, { ...cookieOptions(), maxAge: 300000 });
        },
        afterVerify(req, res, user, origin) {
            res.clearCookie(FLOW_COOKIE, cookieOptions());
            setIdentity(req, res, user);
            auth.rememberAuthentication(user.id, getSessionProof(req), origin);
        } });
}

function installPasskeyAdminRoutes(router, { auth, getOrigin }) {
    router.get('/passkey-origins', (req, res) => res.set('Cache-Control', 'no-store').json({ ...auth.passkeyOriginSettings(), dependencies: auth.passkeyDomainDependencies() }));
    router.put('/passkey-origins', (req, res) => {
        if (req.get('Sec-Fetch-Site') === 'cross-site' || req.get('Origin') && req.get('Origin') !== getOrigin(req)) return res.status(403).json({ error: 'ORIGIN_MISMATCH' });
        if (!req.is('application/json')) return res.status(415).json({ error: 'CONTENT_TYPE_INVALID' });
        res.set('Cache-Control', 'no-store').json({ ...auth.savePasskeyOriginSettings(req.body), dependencies: auth.passkeyDomainDependencies() });
    });
    router.get('/users/:id/passkeys', (req, res) => {
        try { res.set('Cache-Control', 'no-store').json({ passkeys: auth.passkeys(req.params.id) }); }
        catch (error) { res.status(404).json({ error: error.message }); }
    });
    router.delete('/users/:id/passkeys/:credentialId', (req, res) => {
        if (req.get('Sec-Fetch-Site') === 'cross-site' || req.get('Origin') && req.get('Origin') !== getOrigin(req)) return res.status(403).json({ error: 'ORIGIN_MISMATCH' });
        try { auth.removePasskey(req.params.id, req.params.credentialId); res.set('Cache-Control', 'no-store').json({ ok: true }); }
        catch (error) { res.status(error.message === 'PASSKEY_LAST_CREDENTIAL' ? 409 : 404).json({ error: error.message }); }
    });
}

module.exports = { installPasskeyRoutes, installPasskeyAuthenticationRoutes, installPasskeyAdminRoutes, FLOW_COOKIE, COOKIE_PATH };
