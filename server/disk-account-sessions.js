'use strict';
const crypto = require('node:crypto');

// Each account has its own HttpOnly proof of login. A selected user ID is only
// a selector, never a credential. Separate cookies also avoid two login popups
// overwriting a shared account-list cookie with stale contents.
function createDiskAccountSessions({ cookieName = 'drop2tunnel_telegram_drive', keyForRequest,
    legacyKeysForRequest = () => [], user, resolveLegacy = (_req, value) => user(value.id),
    secure = () => false, now = Date.now, isRevoked = () => false, maxAccounts = 10 }) {
    const prefix = cookieName + '_account_';
    const accountCookie = id => prefix + crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 24);
    const cookies = req => new Map(String(req.headers?.cookie || '').split(';').map(part => part.trim()).filter(Boolean)
        .map(part => { const index = part.indexOf('='); return [part.slice(0, index), part.slice(index + 1)]; }));
    const sign = (req, identity) => {
        const body = Buffer.from(JSON.stringify({ id: identity.id, version: 2, exp: now() + 7 * 86400000, sid: crypto.randomBytes(16).toString('base64url') })).toString('base64url');
        return body + '.' + crypto.createHmac('sha256', keyForRequest(req)).update(body).digest('base64url');
    };
    function decode(req, token, allowExpired = false) {
        if (!token || token.length > 4096) return null;
        const [body, signature, extra] = String(token).split('.');
        if (!body || !signature || extra) return null;
        const keys = [keyForRequest(req), ...legacyKeysForRequest(req)].filter(Boolean);
        if (!keys.some(key => {
            const expected = crypto.createHmac('sha256', key).update(body).digest('base64url');
            return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
        })) return null;
        try {
            const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            if (!value?.id || !Number.isSafeInteger(value.exp) || !allowExpired && value.exp <= now()) return null;
            const identity = value.version === 2 ? user(value.id) : resolveLegacy(req, value);
            if (!identity) return null;
            const session = cookieName + '=' + token;
            if (isRevoked(session, value.exp)) return null;
            return { identity, token, expiresAt: value.exp, expired: value.exp <= now() };
        } catch (_) { return null; }
    }
    function entries(req, allowExpired = false) {
        const values = cookies(req), byId = new Map();
        const active = decode(req, values.get(cookieName), allowExpired);
        if (active) byId.set(active.identity.id, active);
        for (const [name, value] of values) {
            if (!name.startsWith(prefix)) continue;
            const entry = decode(req, value, allowExpired);
            if (entry && name === accountCookie(entry.identity.id)) byId.set(entry.identity.id, entry);
        }
        return { values, active, byId };
    }
    function bind(req, entry) {
        if (!entry) return null;
        req.diskSessionCookie = cookieName + '=' + entry.token;
        req.diskSessionExpiresAt = entry.expiresAt;
        req.diskAccountId = entry.identity.id;
        return entry.identity;
    }
    const append = (req, res, name, value, age) => res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure(req) ? '; Secure' : ''}`);
    function identity(req) {
        const header = String(req.get?.('X-Disk-Account') ?? req.headers?.['x-disk-account'] ?? '');
        const query = String(req.query?.disk_account || '');
        if (header && query && header !== query) return null;
        const selected = header || query;
        const values = cookies(req);
        // The common request checks only its selected account, not every saved
        // login. This keeps upload chunks and metadata reads inexpensive.
        const entry = decode(req, selected ? values.get(accountCookie(selected)) : values.get(cookieName));
        if (entry && (!selected || entry.identity.id === selected)) return bind(req, entry);
        const legacy = selected ? decode(req, values.get(cookieName)) : null;
        return bind(req, legacy?.identity.id === selected ? legacy : null);
    }
    function list(req) {
        const { active, byId } = entries(req, true);
        const selected = String(req.get?.('X-Disk-Account') ?? req.headers?.['x-disk-account'] ?? req.query?.disk_account ?? '');
        return [...byId.values()].map(entry => ({ identity: entry.identity, expiresAt: entry.expiresAt,
            active: !entry.expired && entry.identity.id === (selected || active?.identity.id), reauthRequired: entry.expired }));
    }
    function set(req, res, value) {
        const { active, byId } = entries(req, true);
        if (!byId.has(value.id) && byId.size >= maxAccounts) throw new Error('DISK_ACCOUNT_LIMIT');
        if (active && active.identity.id !== value.id) append(req, res, accountCookie(active.identity.id), active.token, 30 * 86400);
        const existing = byId.get(value.id);
        const token = existing && !existing.expired ? existing.token : sign(req, value);
        append(req, res, accountCookie(value.id), token, 30 * 86400);
        append(req, res, cookieName, token, 7 * 86400);
        bind(req, decode(req, token));
        return value;
    }
    function select(req, res, id) {
        const { byId } = entries(req);
        const entry = byId.get(String(id));
        if (!entry) throw new Error('LOGIN_REQUIRED');
        append(req, res, accountCookie(entry.identity.id), entry.token, 30 * 86400);
        append(req, res, cookieName, entry.token, Math.max(1, Math.floor((entry.expiresAt - now()) / 1000)));
        return bind(req, entry);
    }
    function remove(req, res, id, revoke) {
        const { active, byId } = entries(req, true), entry = byId.get(String(id));
        if (!entry) throw new Error('LOGIN_REQUIRED');
        bind(req, entry); revoke?.(req);
        append(req, res, accountCookie(entry.identity.id), '', 0);
        byId.delete(entry.identity.id);
        const next = active?.identity.id === entry.identity.id || !active || active.expired
            ? [...byId.values()].find(item => !item.expired) : active;
        append(req, res, cookieName, next?.token || '', next ? Math.max(1, Math.floor((next.expiresAt - now()) / 1000)) : 0);
        return next?.identity || null;
    }
    function registerRoutes(app, { origin, revoke, prefix: route = '/api/telegram/drive' }) {
        const noStore = (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); };
        const csrf = (req, res, next) => {
            const requested = req.get('Origin');
            if (requested && requested !== origin(req)) return res.status(403).json({ error: 'ORIGIN_MISMATCH' });
            next();
        };
        const wrap = run => (req, res) => { try { run(req, res); } catch (error) { res.status(error.message === 'LOGIN_REQUIRED' ? 401 : 422).json({ error: error.message }); } };
        app.get(route + '/accounts', noStore, (req, res) => res.json({ accounts: list(req), identity: identity(req) }));
        app.post(route + '/accounts/select', noStore, csrf, wrap((req, res) => {
            const selected = select(req, res, req.body?.accountId);
            res.json({ identity: selected, accounts: list(req).map(item => ({ ...item, active: item.identity.id === selected.id })) });
        }));
        app.delete(route + '/accounts/:accountId', noStore, csrf, wrap((req, res) => {
            const selected = remove(req, res, req.params.accountId, revoke);
            res.json({ identity: selected, accounts: list(req).filter(item => item.identity.id !== req.params.accountId).map(item => ({ ...item, active: item.identity.id === selected?.id })) });
        }));
    }
    // Shared global features need login lifetime/revocation evidence, never the
    // cookie itself. Selection remains separate from retained valid accounts.
    function proofs(req) {
        return [...entries(req).byId.values()].map(entry => ({ id: entry.identity.id, expiresAt: entry.expiresAt,
            hash: crypto.createHash('sha256').update(cookieName + '=' + entry.token).digest('hex') }));
    }
    return { identity, list, set, select, remove, registerRoutes, accountCookie, proofs };
}
module.exports = { createDiskAccountSessions };
