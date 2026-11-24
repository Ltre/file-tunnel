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
function validUsername(value) {
    const name = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,64}$/.test(name)) throw new Error('USERNAME_INVALID');
    return name;
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
    const pending = new Map();
    const handoffs=new Map(),recent=new Map();
    const originSettings=require('./passkey-origin-settings').createPasskeyOriginSettings({dataDir,fallback:trustedOrigins});
    const origins=()=>originSettings.get().origins;
    const publicPasskey=key=>({id:key.id,rpID:key.rpID,remark:key.remark||'',createdAt:key.createdAt||0,lastUsedAt:key.lastUsedAt??null});
    const recentKey=(id,proof,origin)=>digest(id+'\0'+proof+'\0'+origin);
    function prune(map){for(const [id,value] of map)if(value.expiresAt<=now())map.delete(id);if(map.size>=2000)throw Error('PASSKEY_TOO_MANY_REQUESTS');}
    function choices(username,origin){
        const user=data.users.find(item=>item.username===validUsername(username));
        if(!user?.passkeys?.length)throw Error('PASSKEY_ACCOUNT_NOT_FOUND');
        const current=new URL(origin),trusted=origins();
        if(current.protocol!=='https:')throw Error('PASSKEY_HTTPS_REQUIRED');
        const rpIDs=[...new Set(user.passkeys.map(key=>key.rpID))];
        const candidates=rpIDs.filter(rpID=>rpID===current.hostname||trusted.includes(current.origin)&&trusted.some(value=>new URL(value).hostname===rpID));
        candidates.sort((a,b)=>Number(b===current.hostname)-Number(a===current.hostname));
        return {user,candidates};
    }
    function handoff(id,origin,side){
        const flow=handoffs.get(id);
        if(!flow||flow.expiresAt<=now()||flow[side+'Origin']!==origin||!origins().includes(flow.sourceOrigin)||!origins().includes(flow.targetOrigin))throw Error('PASSKEY_FLOW_INVALID');
        return flow;
    }
    let webauthnPromise = null;
    async function passkeyMethods() {
        try {
            webauthnPromise ||= Promise.resolve().then(() => webauthn());
            return await webauthnPromise;
        }
        catch (error) { webauthnPromise = null; if (/MODULE_NOT_FOUND/.test(error.code || '')) throw new Error('PASSKEY_SERVER_UNAVAILABLE'); throw error; }
    }
    queueMicrotask(() => passkeyMethods().catch(() => {}));
    const publicUser = user => user ? { id: user.id, user_id: user.id, name: user.name || user.username || '网盘用户', username: user.username || '', telegramId: user.telegramId || '', provider: user.provider || (user.telegramId ? 'telegram' : 'passkey'), passkeyCount: (user.passkeys || []).length, createdAt: user.createdAt || 0,
        permissions: Object.fromEntries(DISK_PERMISSIONS.map(key => [key, user.permissions?.[key] === true])), permissionVersion: Number(user.permissionVersion) || 0 } : null;
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
        users() { return data.users.map(publicUser); },
        passkeyOrigins:origins,
        passkeyOriginSettings:()=>originSettings.get(),
        savePasskeyOriginSettings:value=>originSettings.save(value),
        passkeyDomainDependencies:()=>data.users.filter(user=>user.passkeys?.length).map(user=>({userId:user.id,username:user.username||user.name||user.id,rpIDs:[...new Set(user.passkeys.map(key=>key.rpID))]})),
        passkeyChoices({username,origin}){
            const {user,candidates}=choices(username,origin);
            return {username:user.username,rpIDs:candidates,currentRpID:new URL(origin).hostname};
        },
        passkeys(id){const user=data.users.find(item=>item.id===String(id));if(!user)throw Error('USER_NOT_FOUND');return (user.passkeys||[]).map(publicPasskey);},
        renamePasskey(id,credentialId,remark){
            if(typeof remark!=='string'||remark.length>100||/[\u0000-\u001f]/.test(remark))throw Error('PASSKEY_REMARK_INVALID');
            const key=data.users.find(item=>item.id===id)?.passkeys?.find(item=>item.id===credentialId);
            if(!key)throw Error('PASSKEY_NOT_FOUND');key.remark=remark.trim();save();return publicPasskey(key);
        },
        removePasskey(id,credentialId){
            const user=data.users.find(item=>item.id===id),key=user?.passkeys?.find(item=>item.id===credentialId);
            if(!key)throw Error('PASSKEY_NOT_FOUND');
            if(user.passkeys.length===1&&!user.telegramId)throw Error('PASSKEY_LAST_CREDENTIAL');
            user.passkeys=user.passkeys.filter(item=>item!==key);save();return publicUser(user);
        },
        rememberAuthentication(id,proof,origin){if(!proof)return;prune(recent);recent.set(recentKey(id,proof,origin),{expiresAt:now()+300000});},
        requireRecentAuthentication(id,proof,origin){if(!proof||!(recent.get(recentKey(id,proof,origin))?.expiresAt>now()))throw Error('PASSKEY_REAUTH_REQUIRED');},
        startHandoff({username,origin,rpID,binding,returnPath='/'}){
            const {user,candidates}=choices(username,origin);
            const sourceOrigin=origins().find(value=>new URL(value).hostname===rpID);
            if(!binding||!candidates.includes(rpID)||!sourceOrigin||!origins().includes(origin))throw Error('PASSKEY_ORIGIN_INVALID');
            const target=new URL(returnPath,origin);
            if(target.origin!==origin||!String(returnPath).startsWith('/')||String(returnPath).startsWith('//'))throw Error('PASSKEY_ORIGIN_INVALID');
            prune(handoffs);const id=crypto.randomBytes(32).toString('base64url');
            handoffs.set(id,{userId:user.id,username:user.username,rpID,sourceOrigin,targetOrigin:origin,binding,returnPath:target.pathname+target.search+target.hash,expiresAt:now()+300000});
            return {flow_id:id,url:sourceOrigin+'/passkey-auth?flow='+id};
        },
        handoffInfo(id,origin){const flow=handoff(id,origin,'source');return {username:flow.username,targetOrigin:flow.targetOrigin,rpID:flow.rpID};},
        cancelHandoff({id,origin,binding}){const flow=handoff(id,origin,'target');if(!binding||binding!==flow.binding)throw Error('PASSKEY_FLOW_INVALID');handoffs.delete(id);},
        async handoffOptions({id,origin,binding}){
            const flow=handoff(id,origin,'source');
            const result=await this.passkeyOptions({kind:'login',username:flow.username,origin,binding,rpID:flow.rpID});
            pending.get(result.flow_id).handoffId=id;return result;
        },
        async handoffVerify({flowId,response,origin,binding}){
            const attempt=pending.get(flowId),id=attempt?.handoffId,flow=handoff(id,origin,'source');
            const identity=await this.passkeyVerify({flowId,response,binding});
            if(identity.id!==flow.userId||flow.codeHash||handoff(id,origin,'source')!==flow)throw Error('PASSKEY_FLOW_INVALID');
            const code=crypto.randomBytes(32).toString('base64url');flow.codeHash=digest(code);
            flow.credentialId=response.id;
            return {url:flow.targetOrigin+'/passkey-auth#complete='+id+'&code='+code};
        },
        completeHandoff({id,code,origin,binding}){
            const flow=handoff(id,origin,'target');
            if(!binding||binding!==flow.binding||!flow.codeHash||flow.codeHash!==digest(code))throw Error('PASSKEY_FLOW_INVALID');
            const user=data.users.find(item=>item.id===flow.userId);
            if(!user?.passkeys?.some(key=>key.rpID===flow.rpID&&key.id===flow.credentialId))throw Error('PASSKEY_FLOW_INVALID');
            handoffs.delete(id);return {identity:publicUser(user),authenticatedRpID:flow.rpID,returnPath:flow.returnPath};
        },
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
        async passkeyOptions({ kind, username, existingUserId = '', origin, binding, rpID = '', allowExisting = false }) {
            if (!['register', 'login'].includes(kind)) throw new Error('PASSKEY_FLOW_INVALID');
            const url = new URL(origin);
            if (url.protocol !== 'https:') throw new Error('PASSKEY_HTTPS_REQUIRED');
            const name = validUsername(username);
            const named = data.users.find(user => user.username === name);
            let user = existingUserId ? data.users.find(item => item.id === existingUserId) : named;
            if (kind === 'register' && named && named.id !== existingUserId) {
                if(allowExisting)return {loginRequired:true,...this.passkeyChoices({username:name,origin})};
                throw new Error('USERNAME_EXISTS');
            }
            const selectedRP=kind==='register'?url.hostname:rpID||url.hostname;
            if(kind==='login'){
                const {candidates}=choices(name,origin);
                if(!candidates.includes(selectedRP)||!user?.passkeys?.some(key=>key.rpID===selectedRP))throw new Error('PASSKEY_ACCOUNT_NOT_FOUND');
            }
            if (existingUserId && !user) throw new Error('USER_NOT_FOUND');
            if (kind === 'register' && user?.username && user.username !== name) throw new Error('USERNAME_EXISTS');
            const userId = user?.id || crypto.randomUUID();
            const methods = await passkeyMethods();
            const credentials = (user?.passkeys || []).filter(key => key.rpID === selectedRP).map(key => ({ id: key.id, transports: key.transports }));
            const options = kind === 'register'
                ? await methods.generateRegistrationOptions({ rpName: 'Telegram 虚拟网盘', rpID: selectedRP, userID: new TextEncoder().encode(userId), userName: name, userDisplayName:name, attestationType: 'none', excludeCredentials: credentials, authenticatorSelection: { residentKey: 'required', userVerification: 'required' } })
                : await methods.generateAuthenticationOptions({ rpID: selectedRP, allowCredentials: credentials, userVerification: 'required' });
            for (const [id, flow] of pending) if (flow.expiresAt <= now()) pending.delete(id);
            if (pending.size >= 2000) throw new Error('PASSKEY_TOO_MANY_REQUESTS');
            const flowId = crypto.randomBytes(32).toString('base64url');
            pending.set(flowId, { kind, name, userId, existingUserId, challenge: options.challenge, rpID: selectedRP, origin: url.origin, binding, expiresAt: now() + 300000 });
            return { flow_id: flowId, options };
        },
        async passkeyVerify({ flowId, response, binding, existingUserId = '', origin = '' }) {
            const flow = pending.get(flowId); pending.delete(flowId);
            if (!flow || flow.expiresAt <= now() || !binding || flow.binding !== binding || flow.existingUserId !== existingUserId || origin&&origin!==flow.origin) throw new Error('PASSKEY_FLOW_INVALID');
            if(flow.rpID!==new URL(flow.origin).hostname&&(!origins().includes(flow.origin)||!origins().some(value=>new URL(value).hostname===flow.rpID)))throw Error('PASSKEY_ORIGIN_INVALID');
            const methods = await passkeyMethods();
            let user = data.users.find(item => item.id === flow.userId);
            if (flow.kind === 'register') {
                const result = await methods.verifyRegistrationResponse({ response, expectedChallenge: flow.challenge, expectedOrigin: flow.origin, expectedRPID: flow.rpID, requireUserVerification: true });
                if (!result.verified || !result.registrationInfo || flow.expiresAt<=now()) throw new Error('PASSKEY_VERIFICATION_FAILED');
                const credential = result.registrationInfo.credential;
                if (data.users.some(item => (item.passkeys || []).some(key => key.id === credential.id))) throw new Error('PASSKEY_EXISTS');
                if (data.users.some(item => item.username === flow.name && item.id !== flow.userId)) throw new Error('USERNAME_EXISTS');
                if (!user) { user = { id: flow.userId, createdAt: now(), name: flow.name }; data.users.push(user); }
                user.username = flow.name;
                (user.passkeys ||= []).push({ id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64'), counter: credential.counter, transports: credential.transports || [], rpID: flow.rpID, createdAt: now(), remark:'', lastUsedAt:0 });
            } else {
                const credential = user?.passkeys?.find(key => key.id === response?.id && key.rpID === flow.rpID);
                if (!credential) throw new Error('PASSKEY_VERIFICATION_FAILED');
                const result = await methods.verifyAuthenticationResponse({ response, expectedChallenge: flow.challenge, expectedOrigin: flow.origin, expectedRPID: flow.rpID, requireUserVerification: true, credential: { ...credential, publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64')) } });
                if (!result.verified || flow.expiresAt<=now() || !user.passkeys.includes(credential) ||
                    credential.counter>0&&result.authenticationInfo.newCounter>0&&result.authenticationInfo.newCounter<=credential.counter ||
                    response.response?.userHandle&&Buffer.from(response.response.userHandle,'base64url').toString('utf8')!==user.id) throw new Error('PASSKEY_VERIFICATION_FAILED');
                credential.counter = result.authenticationInfo.newCounter;
                credential.lastUsedAt=now();
            }
            save(); return {...publicUser(user),authenticatedRpID:flow.rpID};
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
