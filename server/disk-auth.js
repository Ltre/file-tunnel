'use strict';
const crypto = require('crypto');
const path = require('path');
const { promisify } = require('util');
const { loadKey } = require('./disk-data');
const { openDiskRepository } = require('./disk-repository');
const scrypt = promisify(crypto.scrypt);
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const DISK_PERMISSIONS = Object.freeze(['disk.s3.manage', 'disk.riskyUpload', 'webZip.publishEdit']);
const emptyPermissions = () => Object.fromEntries(DISK_PERMISSIONS.map(key => [key, false]));
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
function createDiskAuth({ dataDir, now = Date.now, tokenTTL = 3600000, webauthn = () => import('@simplewebauthn/server'), trustedOrigins = () => [] }) {
    const key = loadKey(path.join(dataDir, 'disk-secret.key'));
    const repository = openDiskRepository(dataDir);
    const tables = ['users', 'apps', 'backends', 'tokens'];
    const states = Object.fromEntries(tables.map(table => [table, repository.loadWithRevision(table)]));
    const data = Object.fromEntries(tables.map(table => [table, states[table].items]));
    const reloadPersistence = () => {
        for (const table of tables) {
            states[table] = repository.loadWithRevision(table);
            data[table] = states[table].items;
        }
    };
    const save = () => {
        try {
            repository.replaceMany([
                { table: 'users', items: data.users, keyOf: item => item.id, base: states.users.revisions },
                { table: 'apps', items: data.apps, keyOf: item => item.app_id, base: states.apps.revisions },
                { table: 'backends', items: data.backends, keyOf: item => item.id, base: states.backends.revisions },
                { table: 'tokens', items: data.tokens, keyOf: item => item.hash, base: states.tokens.revisions }
            ]);
        } catch (error) {
            reloadPersistence();
            throw error;
        }
    };
    const publicUser = user => user ? { id: user.id, user_id: user.id, name: user.name || user.username || '网盘用户', username: user.username || '', telegramId: user.telegramId || '', provider: user.provider || (user.telegramId ? 'telegram' : 'passkey'), passkeyCount: (user.passkeys || []).length, createdAt: user.createdAt || 0,
        permissions: Object.fromEntries(DISK_PERMISSIONS.map(key => [key, user.permissions?.[key] === true])), permissionVersion: Number(user.permissionVersion) || 0 } : null;
    // Compatibility boundary: reuse the existing shared account records and
    // transaction without making the generic Passkey service depend on Drive.
    const passkeyAuth = require('./passkey-auth').createPasskeyAuth({
        accounts: {
            list: () => data.users,
            add: user => data.users.push(user),
            save,
            publicUser,
            hasAlternativeAuthentication: user => Boolean(user.telegramId)
        },
        originSettings: require('./passkey-origin-settings').createPasskeyOriginSettings({ dataDir, fallback: trustedOrigins }),
        now, webauthn, rpName: 'Telegram 虚拟网盘'
    });
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
        ...passkeyAuth,
        passkeyAuth,
        sessionKey: key,
        user(id) { return publicUser(data.users.find(user => user.id === String(id))); },
        users() { return data.users.map(publicUser); },
        hasPermission(id, permission) {
            return DISK_PERMISSIONS.includes(permission) && data.users.find(user => user.id === String(id))?.permissions?.[permission] === true;
        },
        setPermissions(id, changes, operator = 'administrator') {
            const user = data.users.find(entry => entry.id === String(id));
            if (!user) throw new Error('USER_NOT_FOUND');
            if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
                !Object.keys(changes).length || Object.keys(changes).some(key => !DISK_PERMISSIONS.includes(key) || typeof changes[key] !== 'boolean'))
                throw new Error('DISK_PERMISSION_INVALID');
            const previous = { ...user };
            const permissions = { ...emptyPermissions(), ...user.permissions, ...changes };
            if (DISK_PERMISSIONS.some(key => permissions[key] !== (user.permissions?.[key] === true))) {
                user.permissions = permissions;
                user.permissionVersion = (Number(user.permissionVersion) || 0) + 1;
                user.permissionUpdatedAt = now();
                user.permissionUpdatedBy = operator;
                try { save(); } catch (error) { Object.assign(user, previous); throw error; }
            }
            return publicUser(user);
        },
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
        issueToken(verifiedApp, backend, credentials = {}) {
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
            const encryptedCredentials = seal(JSON.stringify({ app_id: app.app_id, app_secret: credentials.app_secret || '', tg_bot_token: backend.token, tg_channel: String(backend.channelId) }));
            data.tokens.push({ hash: digest(token), appId: app.app_id, revision: app.revision, backendId: saved.id, encryptedCredentials, expiresAt: now() + tokenTTL });
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
            const saved = data.backends.find(backend => backend.id === item.backendId);
            if (!saved) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
            // Older tokens remain compatible; new tokens resolve the encrypted bundle
            // by SHA-256(access_token). Only Telegram credentials leave this auth layer.
            const credentials = item.encryptedCredentials ? JSON.parse(unseal(item.encryptedCredentials)) : null;
            if (credentials && credentials.app_id !== app.app_id) throw new Error('ACCESS_TOKEN_INVALID');
            const storage = { id: saved.id, token: credentials?.tg_bot_token || unseal(saved.encryptedToken), channelId: credentials?.tg_channel || saved.channelId, baseUrl: saved.baseUrl };
            return { appId: app.app_id, backendId: item.backendId, passkeyOrigin: app.passkeyOrigin, storage };
        },
        backend(id) {
            const backend = data.backends.find(item => item.id === id);
            if (!backend) throw new Error('STORAGE_BACKEND_UNAVAILABLE');
            return { id: backend.id, token: unseal(backend.encryptedToken), channelId: backend.channelId, baseUrl: backend.baseUrl };
        }
    };
}
module.exports = { createDiskAuth };
