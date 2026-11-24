'use strict';
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function validUsername(value) {
    const name = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,64}$/.test(name)) throw new Error('USERNAME_INVALID');
    return name;
}

// Passkey authentication is independent of storage, account permissions and
// consuming products. The host supplies the existing account persistence and
// identity projection; no credentials or users are migrated by this service.
function createPasskeyAuth({ accounts, originSettings, now = Date.now,
    webauthn = () => import('@simplewebauthn/server'), rpName = 'Drop2Tunnel' }) {
    const users = () => accounts.list();
    const save = () => accounts.save();
    const publicUser = user => accounts.publicUser(user);
    const pending = new Map();
    const handoffs=new Map(),recent=new Map();
    const origins=()=>originSettings.get().origins;
    const publicPasskey=key=>({id:key.id,rpID:key.rpID,remark:key.remark||'',createdAt:key.createdAt||0,lastUsedAt:key.lastUsedAt??null});
    const recentKey=(id,proof,origin)=>digest(id+'\0'+proof+'\0'+origin);
    function prune(map){for(const [id,value] of map)if(value.expiresAt<=now())map.delete(id);if(map.size>=2000)throw Error('PASSKEY_TOO_MANY_REQUESTS');}
    function choices(username,origin){
        const user=users().find(item=>item.username===validUsername(username));
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
    return {
        passkeyOrigins:origins,
        passkeyOriginSettings:()=>originSettings.get(),
        savePasskeyOriginSettings:value=>originSettings.save(value),
        passkeyDomainDependencies:()=>users().filter(user=>user.passkeys?.length).map(user=>({userId:user.id,username:user.username||user.name||user.id,rpIDs:[...new Set(user.passkeys.map(key=>key.rpID))]})),
        passkeyChoices({username,origin}){
            const {user,candidates}=choices(username,origin);
            return {username:user.username,rpIDs:candidates,currentRpID:new URL(origin).hostname};
        },
        passkeys(id){const user=users().find(item=>item.id===String(id));if(!user)throw Error('USER_NOT_FOUND');return (user.passkeys||[]).map(publicPasskey);},
        renamePasskey(id,credentialId,remark){
            if(typeof remark!=='string'||remark.length>100||/[\u0000-\u001f]/.test(remark))throw Error('PASSKEY_REMARK_INVALID');
            const key=users().find(item=>item.id===id)?.passkeys?.find(item=>item.id===credentialId);
            if(!key)throw Error('PASSKEY_NOT_FOUND');key.remark=remark.trim();save();return publicPasskey(key);
        },
        removePasskey(id,credentialId){
            const user=users().find(item=>item.id===id),key=user?.passkeys?.find(item=>item.id===credentialId);
            if(!key)throw Error('PASSKEY_NOT_FOUND');
            if(user.passkeys.length===1&&!accounts.hasAlternativeAuthentication(user))throw Error('PASSKEY_LAST_CREDENTIAL');
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
            const user=users().find(item=>item.id===flow.userId);
            if(!user?.passkeys?.some(key=>key.rpID===flow.rpID&&key.id===flow.credentialId))throw Error('PASSKEY_FLOW_INVALID');
            handoffs.delete(id);return {identity:publicUser(user),authenticatedRpID:flow.rpID,returnPath:flow.returnPath};
        },
        async passkeyOptions({ kind, username, existingUserId = '', origin, binding, rpID = '', allowExisting = false }) {
            if (!['register', 'login'].includes(kind)) throw new Error('PASSKEY_FLOW_INVALID');
            const url = new URL(origin);
            if (url.protocol !== 'https:') throw new Error('PASSKEY_HTTPS_REQUIRED');
            const name = validUsername(username);
            const named = users().find(user => user.username === name);
            let user = existingUserId ? users().find(item => item.id === existingUserId) : named;
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
                ? await methods.generateRegistrationOptions({ rpName, rpID: selectedRP, userID: new TextEncoder().encode(userId), userName: name, userDisplayName:name, attestationType: 'none', excludeCredentials: credentials, authenticatorSelection: { residentKey: 'required', userVerification: 'required' } })
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
            let user = users().find(item => item.id === flow.userId);
            if (flow.kind === 'register') {
                const result = await methods.verifyRegistrationResponse({ response, expectedChallenge: flow.challenge, expectedOrigin: flow.origin, expectedRPID: flow.rpID, requireUserVerification: true });
                if (!result.verified || !result.registrationInfo || flow.expiresAt<=now()) throw new Error('PASSKEY_VERIFICATION_FAILED');
                const credential = result.registrationInfo.credential;
                if (users().some(item => (item.passkeys || []).some(key => key.id === credential.id))) throw new Error('PASSKEY_EXISTS');
                if (users().some(item => item.username === flow.name && item.id !== flow.userId)) throw new Error('USERNAME_EXISTS');
                if (!user) { user = { id: flow.userId, createdAt: now(), name: flow.name }; accounts.add(user); }
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
    };
}
module.exports = { createPasskeyAuth };
