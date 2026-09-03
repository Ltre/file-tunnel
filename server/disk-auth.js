'use strict';
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const { readJson, writeJson, loadKey } = require('./disk-data');
const scrypt = promisify(crypto.scrypt);
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
async function hashSecret(value) {
    const salt = crypto.randomBytes(16).toString('hex');
    return salt + ':' + (await scrypt(value, salt, 64)).toString('hex');
}
async function verifySecret(value, hash = '') {
    const [salt, expected] = hash.split(':');
    const actual = await scrypt(String(value), salt || 'invalid-identity-salt', 64);
    const stored = Buffer.from(expected || '', 'hex');
    return stored.length === actual.length && crypto.timingSafeEqual(stored, actual);
}
function validUsername(value) {
    const name = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,64}$/.test(name)) throw new Error('USERNAME_INVALID');
    return name;
}
function createDiskAuth({ dataDir, now = Date.now, tokenTTL = 3600000, webauthn = () => import('@simplewebauthn/server') }) {
    const file = path.join(dataDir, 'disk-auth.json');
    const key = loadKey(path.join(dataDir, 'disk-secret.key'));
    const data = readJson(file, { users: [], apps: [], backends: [], tokens: [] });
    const save = () => writeJson(file, data);
    const pending = new Map();
    const publicUser = user => user ? { id: user.id, user_id: user.id, name: user.name || user.username || '网盘用户', username: user.username || '', telegramId: user.telegramId || '', passkeyCount: (user.passkeys || []).length } : null;
    const publicApp = app => ({ app_id: app.app_id, remark: app.remark, enabled: app.enabled, passkey_origin: app.passkeyOrigin || '', secretConfigured: true, createdAt: app.createdAt, lastUsedAt: app.lastUsedAt || 0, lastIssuedAt: app.lastIssuedAt || 0 });
    function seal(value) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
    }
    function unseal(value) {
        const raw = Buffer.from(value, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(-16));
        return Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString('utf8');
    }
    return {
        sessionKey: key,
        user(id) { return publicUser(data.users.find(user => user.id === String(id))); },
        fromTelegram(identity, provider = 'telegram') {
            const telegramId = String(identity.id);
            if (!/^\d{1,20}$/.test(telegramId)) throw new Error('TELEGRAM_ID_INVALID');
            let user = data.users.find(user => user.telegramId === telegramId && (user.provider || 'telegram') === provider);
            if (!user) {
                user = { id: crypto.randomUUID(), telegramId, provider, name: String(identity.name || identity.username || ''), createdAt: now() };
                data.users.push(user); save();
            }
            return publicUser(user);
        },
        async passkeyOptions({ kind, username, existingUserId = '', origin, binding }) {
            if (!['register', 'login'].includes(kind)) throw new Error('PASSKEY_FLOW_INVALID');
            const url = new URL(origin);
            if (url.protocol !== 'https:') throw new Error('PASSKEY_HTTPS_REQUIRED');
            const name = validUsername(username);
            const named = data.users.find(user => user.username === name);
            let user = existingUserId ? data.users.find(item => item.id === existingUserId) : named;
            if (kind === 'register' && named && named.id !== existingUserId) throw new Error('USERNAME_EXISTS');
            if (kind === 'login' && (!user || !user.passkeys?.some(key => key.rpID === url.hostname))) throw new Error('PASSKEY_ACCOUNT_NOT_FOUND');
            if (existingUserId && !user) throw new Error('USER_NOT_FOUND');
            if (kind === 'register' && user?.username && user.username !== name) throw new Error('USERNAME_EXISTS');
            const userId = user?.id || crypto.randomUUID();
            const methods = await webauthn();
            const credentials = (user?.passkeys || []).filter(key => key.rpID === url.hostname).map(key => ({ id: key.id, transports: key.transports }));
            const options = kind === 'register'
                ? await methods.generateRegistrationOptions({ rpName: 'Telegram 虚拟网盘', rpID: url.hostname, userID: new TextEncoder().encode(userId), userName: name, attestationType: 'none', excludeCredentials: credentials, authenticatorSelection: { residentKey: 'required', userVerification: 'required' } })
                : await methods.generateAuthenticationOptions({ rpID: url.hostname, allowCredentials: credentials, userVerification: 'required' });
            for (const [id, flow] of pending) if (flow.expiresAt <= now()) pending.delete(id);
            if (pending.size >= 2000) throw new Error('PASSKEY_TOO_MANY_REQUESTS');
            const flowId = crypto.randomBytes(32).toString('base64url');
            pending.set(flowId, { kind, name, userId, existingUserId, challenge: options.challenge, rpID: url.hostname, origin: url.origin, binding, expiresAt: now() + 300000 });
            return { flow_id: flowId, options };
        },
        async passkeyVerify({ flowId, response, binding, existingUserId = '' }) {
            const flow = pending.get(flowId); pending.delete(flowId);
            if (!flow || flow.expiresAt <= now() || flow.binding !== binding || flow.existingUserId !== existingUserId) throw new Error('PASSKEY_FLOW_INVALID');
            const methods = await webauthn();
            let user = data.users.find(item => item.id === flow.userId);
            if (flow.kind === 'register') {
                const result = await methods.verifyRegistrationResponse({ response, expectedChallenge: flow.challenge, expectedOrigin: flow.origin, expectedRPID: flow.rpID, requireUserVerification: true });
                if (!result.verified || !result.registrationInfo) throw new Error('PASSKEY_VERIFICATION_FAILED');
                const credential = result.registrationInfo.credential;
                if (data.users.some(item => (item.passkeys || []).some(key => key.id === credential.id))) throw new Error('PASSKEY_EXISTS');
                if (data.users.some(item => item.username === flow.name && item.id !== flow.userId)) throw new Error('USERNAME_EXISTS');
                if (!user) { user = { id: flow.userId, createdAt: now(), name: flow.name }; data.users.push(user); }
                user.username = flow.name;
                (user.passkeys ||= []).push({ id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64'), counter: credential.counter, transports: credential.transports || [], rpID: flow.rpID, createdAt: now() });
            } else {
                const credential = user?.passkeys?.find(key => key.id === response?.id && key.rpID === flow.rpID);
                if (!credential) throw new Error('PASSKEY_VERIFICATION_FAILED');
                const result = await methods.verifyAuthenticationResponse({ response, expectedChallenge: flow.challenge, expectedOrigin: flow.origin, expectedRPID: flow.rpID, requireUserVerification: true, credential: { ...credential, publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64')) } });
                if (!result.verified) throw new Error('PASSKEY_VERIFICATION_FAILED');
                credential.counter = result.authenticationInfo.newCounter;
            }
            save(); return publicUser(user);
        },
        apps() { return data.apps.map(publicApp); },
        async saveApp(input) {
            const id = String(input.app_id || '').trim();
            if (!/^[a-zA-Z0-9_.-]{3,100}$/.test(id)) throw new Error('APP_ID_INVALID');
            let app = data.apps.find(item => item.app_id === id);
            if (!app && !input.app_secret) throw new Error('APP_SECRET_REQUIRED');
            let secretHash = app?.secretHash;
            if (input.app_secret) {
                if (typeof input.app_secret !== 'string' || input.app_secret.length < 16 || input.app_secret.length > 256) throw new Error('APP_SECRET_LENGTH');
                secretHash = await hashSecret(input.app_secret);
            }
            let passkeyOrigin = '';
            if (input.passkey_origin) {
                const origin = new URL(input.passkey_origin);
                if (origin.protocol !== 'https:' || origin.origin !== input.passkey_origin) throw new Error('PASSKEY_ORIGIN_INVALID');
                passkeyOrigin = origin.origin;
            }
            if (!app) { app = { app_id: id, createdAt: now(), revision: 0 }; data.apps.push(app); }
            Object.assign(app, { secretHash, passkeyOrigin, enabled: input.enabled !== false, remark: String(input.remark || '').slice(0, 500), revision: app.revision + 1 });
            data.tokens = data.tokens.filter(token => token.appId !== id); save();
            return publicApp(app);
        },
        deleteApp(id) {
            data.apps = data.apps.filter(app => app.app_id !== id);
            data.tokens = data.tokens.filter(token => token.appId !== id);
            // File objects retain their encrypted backend for continuity.
            save();
        },
        async authenticateApp(id, secret) {
            const app = data.apps.find(item => item.app_id === id && item.enabled);
            if (typeof secret !== 'string' || secret.length > 256 || !await verifySecret(secret, app?.secretHash) || !app) throw new Error('APP_AUTH_INVALID');
            return { id: app.app_id, revision: app.revision };
        },
        issueToken(verifiedApp, backend) {
            const app = data.apps.find(item => item.app_id === verifiedApp.id && item.enabled && item.revision === verifiedApp.revision);
            if (!app) throw new Error('APP_AUTH_INVALID');
            const fingerprint = digest(backend.token + '\0' + backend.channelId + '\0' + backend.baseUrl);
            let saved = data.backends.find(item => item.fingerprint === fingerprint);
            if (!saved) {
                saved = { id: crypto.randomUUID(), fingerprint, encryptedToken: seal(backend.token), channelId: String(backend.channelId), baseUrl: backend.baseUrl, createdAt: now() };
                data.backends.push(saved);
            }
            const token = crypto.randomBytes(32).toString('base64url');
            data.tokens = data.tokens.filter(item => item.expiresAt > now());
            data.tokens.push({ hash: digest(token), appId: app.app_id, revision: app.revision, backendId: saved.id, expiresAt: now() + tokenTTL });
            app.lastIssuedAt = now(); app.lastUsedAt = now(); save();
            return { access_token: token, token_type: 'Bearer', expires_in: Math.floor(tokenTTL / 1000), backend_id: saved.id };
        },
        access(token) {
            const item = data.tokens.find(entry => entry.hash === digest(token));
            if (!item) throw new Error('ACCESS_TOKEN_INVALID');
            if (item.expiresAt <= now()) throw new Error('ACCESS_TOKEN_EXPIRED');
            const app = data.apps.find(entry => entry.app_id === item.appId && entry.enabled && entry.revision === item.revision);
            if (!app) throw new Error('ACCESS_TOKEN_INVALID');
            if (now() - (app.lastUsedAt || 0) > 60000) { app.lastUsedAt = now(); save(); }
            return { appId: app.app_id, backendId: item.backendId, passkeyOrigin: app.passkeyOrigin };
        },
        backend(id) {
            const backend = data.backends.find(item => item.id === id);
            if (!backend) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
            return { id: backend.id, token: unseal(backend.encryptedToken), channelId: backend.channelId, baseUrl: backend.baseUrl };
        }
    };
}
module.exports = { createDiskAuth };
