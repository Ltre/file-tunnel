const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'tunnel_admin_session';

function base32Encode(buffer) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += alphabet[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
    return output;
}

function base32Decode(input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const character of String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '')) {
        const index = alphabet.indexOf(character);
        if (index < 0) continue;
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function hotp(secret, counter) {
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));
    const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counterBuffer).digest();
    const offset = digest[digest.length - 1] & 15;
    const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    return String(binary).padStart(6, '0');
}

function verifyTotp(secret, token, now = Date.now()) {
    const candidate = String(token || '').replace(/\D/g, '');
    if (candidate.length !== 6) return false;
    const counter = Math.floor(now / 30000);
    for (let drift = -1; drift <= 1; drift += 1) {
        const expected = hotp(secret, counter + drift);
        if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))) return true;
    }
    return false;
}

function parseCookies(header) {
    return String(header || '').split(';').reduce((cookies, part) => {
        const index = part.indexOf('=');
        if (index < 0) return cookies;
        cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
        return cookies;
    }, {});
}

function createAdminAuth(options) {
    const dataDir = options.dataDir;
    const markerPath = path.join(dataDir, '.gauth-admin.json');
    const signingKeyPath = path.join(dataDir, '.admin-session.key');
    const issuer = options.issuer || 'Instant Tunnel Admin';
    let pendingSecret = '';
    let pendingAt = 0;

    function ensurePrivateFile(filePath, contents) {
        fs.mkdirSync(dataDir, { recursive: true });
        if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, contents, { mode: 0o600 });
        try { fs.chmodSync(filePath, 0o600); } catch (_) {}
        return fs.readFileSync(filePath, 'utf8').trim();
    }

    function writePrivateFile(filePath, contents) {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(filePath, contents, { mode: 0o600 });
        try { fs.chmodSync(filePath, 0o600); } catch (_) {}
    }

    function signingKey() {
        return ensurePrivateFile(signingKeyPath, crypto.randomBytes(48).toString('base64url'));
    }

    function readMarker() {
        try {
            const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
            if (marker?.secret) return marker;
            if (!marker?.encryptedSecret || !marker?.iv || !marker?.tag) return null;
            const key = crypto.createHash('sha256').update(signingKey()).digest();
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(marker.iv, 'base64url'));
            decipher.setAuthTag(Buffer.from(marker.tag, 'base64url'));
            const secret = Buffer.concat([
                decipher.update(Buffer.from(marker.encryptedSecret, 'base64url')),
                decipher.final()
            ]).toString('utf8');
            return { ...marker, secret };
        } catch (_) {
            return null;
        }
    }

    function isConfigured() {
        return Boolean(readMarker());
    }

    function getSetup() {
        if (isConfigured()) return null;
        if (!pendingSecret || Date.now() - pendingAt > 10 * 60 * 1000) {
            pendingSecret = base32Encode(crypto.randomBytes(20));
            pendingAt = Date.now();
        }
        const account = options.account || 'administrator';
        const label = encodeURIComponent(`${issuer}:${account}`);
        const uri = `otpauth://totp/${label}?secret=${pendingSecret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
        return { secret: pendingSecret, uri, account, expiresAt: pendingAt + 10 * 60 * 1000 };
    }

    function finishSetup(token) {
        const setup = getSetup();
        if (!setup || !verifyTotp(setup.secret, token)) return false;
        const key = crypto.createHash('sha256').update(signingKey()).digest();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encryptedSecret = Buffer.concat([cipher.update(setup.secret, 'utf8'), cipher.final()]);
        writePrivateFile(markerPath, JSON.stringify({
            version: 1,
            encryptedSecret: encryptedSecret.toString('base64url'),
            iv: iv.toString('base64url'),
            tag: cipher.getAuthTag().toString('base64url'),
            issuer,
            createdAt: new Date().toISOString()
        }, null, 2));
        pendingSecret = '';
        pendingAt = 0;
        return true;
    }

    function verifyToken(token) {
        const marker = readMarker();
        return Boolean(marker && verifyTotp(marker.secret, token));
    }

    function createSession() {
        const marker = readMarker();
        if (!marker) throw new Error('admin-auth-setup-required');
        const payload = Buffer.from(JSON.stringify({
            iat: Date.now(),
            exp: Date.now() + SESSION_TTL_MS,
            marker: marker.createdAt,
            nonce: crypto.randomBytes(12).toString('base64url')
        })).toString('base64url');
        const signature = crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
        return `${payload}.${signature}`;
    }

    function verifySession(value) {
        const [payload, signature] = String(value || '').split('.');
        if (!payload || !signature) return false;
        const expected = crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
        if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
        try {
            const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            const marker = readMarker();
            return Number(data.exp) > Date.now() && Boolean(marker?.createdAt) && data.marker === marker.createdAt;
        } catch (_) {
            return false;
        }
    }

    function isAuthenticated(req) {
        return verifySession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
    }

    function cookieHeader(req, value, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
        const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
        return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    }

    function requireAuth(req, res, next) {
        if (isAuthenticated(req)) return next();
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'admin-auth-required' });
        return res.redirect(`/admin-auth?next=${encodeURIComponent(req.originalUrl || '/admin')}`);
    }

    return {
        markerPath,
        isConfigured,
        isAuthenticated,
        getSetup,
        finishSetup,
        verifyToken,
        createSession,
        cookieHeader,
        requireAuth
    };
}

module.exports = { createAdminAuth };
