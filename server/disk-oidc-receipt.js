'use strict';
const crypto = require('node:crypto');

// A completion receipt is separate from the login credential: re-verifying an
// already valid account must not rotate its session or invalidate upload proof.
function createDiskOidcReceipt({ keyForRequest, secure = () => false, now = Date.now }) {
    const cookieName = 'drop2tunnel_disk_oidc_receipt';
    const validAttempt = value => /^[a-zA-Z0-9_-]{16,100}$/.test(String(value || ''));
    const signature = (req, body) => crypto.createHmac('sha256', keyForRequest(req)).update(body).digest('base64url');
    function record(req, res, { attemptId, result, accountId = '', error = '' }) {
        if (!validAttempt(attemptId) || !['success', 'error'].includes(result)) return;
        const value = { attemptId, result, accountId: result === 'success' ? String(accountId) : '',
            error: result === 'error' ? String(error).slice(0, 120) : '', expiresAt: now() + 600000 };
        const body = Buffer.from(JSON.stringify(value)).toString('base64url');
        res.append('Set-Cookie', `${cookieName}=${body}.${signature(req, body)}; Path=/api/telegram/drive; HttpOnly; SameSite=Lax; Max-Age=600${secure(req) ? '; Secure' : ''}`);
    }
    function get(req, attemptId) {
        if (!validAttempt(attemptId)) return null;
        const token = String(req.headers?.cookie || '').split(';').map(part => part.trim())
            .find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
        if (token.length > 2048) return null;
        const [body, mac, extra] = token.split('.');
        if (!body || !/^[a-zA-Z0-9_-]{43}$/.test(mac || '') || extra) return null;
        const expected = signature(req, body);
        if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
        try {
            const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            if (value.attemptId !== attemptId || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now()
                || !['success', 'error'].includes(value.result)) return null;
            return value;
        } catch (_) { return null; }
    }
    return { record, get, validAttempt };
}
module.exports = { createDiskOidcReceipt };
