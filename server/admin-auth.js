const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {privateKeyFile}=require('./private-key-file');
const {createAdminDbscSessions}=require('./admin-dbsc-sessions');

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

function createAdminAuth(options) {
    const dataDir = options.dataDir;
    const markerPath = path.join(dataDir, '.gauth-admin.json');
    const signingKeyPath = path.join(dataDir, '.admin-session.key');
    const defaultIssuer = options.issuer || 'Instant Tunnel Admin';
    let pendingSecret = '';
    let pendingAt = 0;
    let pendingIssuer = defaultIssuer;

    function normalizeIssuer(value) {
        return String(value || defaultIssuer)
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .trim()
            .slice(0, 64) || defaultIssuer;
    }

    function ensurePrivateFile(filePath, contents) {
        return privateKeyFile(filePath,()=>contents);
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
        return fs.existsSync(markerPath);
    }

    function getSetup(requestedIssuer) {
        if (isConfigured()) return null;
        if (!pendingSecret || Date.now() - pendingAt > 10 * 60 * 1000) {
            pendingSecret = base32Encode(crypto.randomBytes(20));
            pendingAt = Date.now();
        }
        pendingIssuer = normalizeIssuer(requestedIssuer);
        const account = options.account || 'administrator';
        const label = encodeURIComponent(`${pendingIssuer}:${account}`);
        const uri = `otpauth://totp/${label}?secret=${pendingSecret}&issuer=${encodeURIComponent(pendingIssuer)}&algorithm=SHA1&digits=6&period=30`;
        return { secret: pendingSecret, uri, issuer: pendingIssuer, account, expiresAt: pendingAt + 10 * 60 * 1000 };
    }

    function finishSetup(token, requestedIssuer) {
        const setup = getSetup(requestedIssuer);
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
            issuer: setup.issuer,
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
    const dbsc=createAdminDbscSessions({dataDir,signingKey,marker:()=>readMarker()?.createdAt||''});

    function isAuthenticated(req) {
        return Boolean(dbsc.verify(req,true));
    }

    function requireAuth(req, res, next) {
        if (isAuthenticated(req)) return next();
        res.setHeader('X-Admin-Auth-Reason',diagnose(req));
        if (req.path.startsWith('/api/') || String(req.originalUrl||'').startsWith('/api/'))
            return res.status(401).json({ error: 'admin-auth-required' });
        return res.redirect(`/admin-auth?next=${encodeURIComponent(req.originalUrl || '/admin')}`);
    }

    return {
        diagnose,
        markerPath,
        isConfigured,
        isAuthenticated,
        getSetup,
        finishSetup,
        verifyToken,
        beginBinding:dbsc.begin,
        registerDbsc:dbsc.register,
        refreshDbsc:dbsc.refresh,
        sessions:dbsc.list,
        getSession:dbsc.verify,
        revokeSession:dbsc.revoke,
        logout:dbsc.revokeRequest,
        cookieHeader:dbsc.cookieHeader,
        requireAuth
    };
    function diagnose(req){if(isAuthenticated(req))return 'VALID';if(!readMarker())return 'AUTH_CONFIGURATION_UNREADABLE';return 'DBSC_BINDING_REQUIRED';}
}

module.exports = { createAdminAuth };
