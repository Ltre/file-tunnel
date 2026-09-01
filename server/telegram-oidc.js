'use strict';

const crypto = require('crypto');

const TELEGRAM_OIDC_ISSUER = 'https://oauth.telegram.org';
const TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT = `${TELEGRAM_OIDC_ISSUER}/auth`;
const TELEGRAM_OIDC_TOKEN_ENDPOINT = `${TELEGRAM_OIDC_ISSUER}/token`;
const TELEGRAM_OIDC_JWKS_ENDPOINT = `${TELEGRAM_OIDC_ISSUER}/.well-known/jwks.json`;
const SUPPORTED_SIGNING_ALGORITHMS = new Set(['RS256', 'ES256', 'EdDSA', 'ES256K']);

function decodeJwtPart(value) {
    try {
        return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
    } catch (_) {
        throw new Error('telegram-oidc-token-malformed');
    }
}

function createRandomValue(size = 32) {
    return crypto.randomBytes(size).toString('base64url');
}

function createCodeChallenge(verifier) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function createTelegramOidcClient(options = {}) {
    const fetchImpl = options.fetchImpl || global.fetch;
    const now = options.now || (() => Date.now());
    const jwksTtlMs = Math.max(60_000, Number(options.jwksTtlMs) || 60 * 60 * 1000);
    let jwksCache = { fetchedAt: 0, keys: [] };

    function createAuthorizationRequest({ clientId, redirectUri, scope = 'openid profile' }) {
        if (!clientId || !redirectUri) throw new Error('telegram-oidc-not-configured');
        const state = createRandomValue(32);
        const nonce = createRandomValue(32);
        const codeVerifier = createRandomValue(64);
        const url = new URL(TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT);
        url.searchParams.set('client_id', String(clientId));
        url.searchParams.set('redirect_uri', String(redirectUri));
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', scope);
        url.searchParams.set('state', state);
        url.searchParams.set('nonce', nonce);
        url.searchParams.set('code_challenge', createCodeChallenge(codeVerifier));
        url.searchParams.set('code_challenge_method', 'S256');
        return { url: url.href, state, nonce, codeVerifier };
    }

    async function exchangeCode({ clientId, clientSecret, code, codeVerifier, redirectUri }) {
        if (!clientId || !clientSecret || !code || !codeVerifier || !redirectUri) throw new Error('telegram-oidc-token-request-invalid');
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code: String(code),
            redirect_uri: String(redirectUri),
            client_id: String(clientId),
            code_verifier: String(codeVerifier)
        });
        const authorization = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const response = await fetchImpl(TELEGRAM_OIDC_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                Authorization: `Basic ${authorization}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.id_token) throw new Error(`telegram-oidc-token-exchange-${response.status || 'failed'}`);
        return payload;
    }

    async function loadSigningKeys(force = false) {
        if (!force && jwksCache.keys.length && now() - jwksCache.fetchedAt < jwksTtlMs) return jwksCache.keys;
        const response = await fetchImpl(TELEGRAM_OIDC_JWKS_ENDPOINT, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(payload.keys)) throw new Error('telegram-oidc-jwks-unavailable');
        jwksCache = { fetchedAt: now(), keys: payload.keys };
        return jwksCache.keys;
    }

    async function resolveSigningKey(header) {
        const matches = keys => keys.find(key => key.kid === header.kid && (!key.alg || key.alg === header.alg) && (!key.use || key.use === 'sig'));
        let key = matches(await loadSigningKeys(false));
        if (!key) key = matches(await loadSigningKeys(true));
        if (!key) throw new Error('telegram-oidc-signing-key-not-found');
        return crypto.createPublicKey({ key, format: 'jwk' });
    }

    async function verifyIdToken(idToken, { clientId, nonce, clockToleranceSeconds = 60 } = {}) {
        const parts = String(idToken || '').split('.');
        if (parts.length !== 3) throw new Error('telegram-oidc-token-malformed');
        const header = decodeJwtPart(parts[0]);
        const claims = decodeJwtPart(parts[1]);
        if (!header.kid || !SUPPORTED_SIGNING_ALGORITHMS.has(header.alg)) throw new Error('telegram-oidc-algorithm-not-supported');
        const publicKey = await resolveSigningKey(header);
        const signedContent = Buffer.from(`${parts[0]}.${parts[1]}`);
        const signature = Buffer.from(parts[2], 'base64url');
        let verifyAlgorithm = 'sha256';
        let verifyKey = publicKey;
        if (header.alg === 'RS256') verifyAlgorithm = 'RSA-SHA256';
        if (header.alg === 'EdDSA') verifyAlgorithm = null;
        if (header.alg === 'ES256' || header.alg === 'ES256K') verifyKey = { key: publicKey, dsaEncoding: 'ieee-p1363' };
        if (!crypto.verify(verifyAlgorithm, signedContent, verifyKey, signature)) throw new Error('telegram-oidc-signature-invalid');

        const nowSeconds = Math.floor(now() / 1000);
        const tolerance = Math.max(0, Number(clockToleranceSeconds) || 0);
        const audience = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud || '')];
        if (claims.iss !== TELEGRAM_OIDC_ISSUER) throw new Error('telegram-oidc-issuer-invalid');
        if (!clientId || !audience.includes(String(clientId))) throw new Error('telegram-oidc-audience-invalid');
        if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= nowSeconds - tolerance) throw new Error('telegram-oidc-token-expired');
        if (Number.isFinite(Number(claims.nbf)) && Number(claims.nbf) > nowSeconds + tolerance) throw new Error('telegram-oidc-token-not-active');
        if (Number.isFinite(Number(claims.iat)) && Number(claims.iat) > nowSeconds + tolerance) throw new Error('telegram-oidc-issued-at-invalid');
        if (!nonce || claims.nonce !== nonce) throw new Error('telegram-oidc-nonce-invalid');
        if (!claims.sub) throw new Error('telegram-oidc-subject-missing');
        return claims;
    }

    return { createAuthorizationRequest, exchangeCode, verifyIdToken };
}

module.exports = {
    TELEGRAM_OIDC_ISSUER,
    TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT,
    TELEGRAM_OIDC_TOKEN_ENDPOINT,
    TELEGRAM_OIDC_JWKS_ENDPOINT,
    createCodeChallenge,
    createTelegramOidcClient
};
