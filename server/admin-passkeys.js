'use strict';

// Administrator credentials have their own repository, user handle and flow
// namespace. They never read or accept front-end account Passkey credentials.
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const FLOW_MS=5*60*1000,MAX_KEYS=100,MAX_FLOWS=500;
const random=()=>crypto.randomBytes(32).toString('base64url');
function originInfo(value){
    try{
        const url=new URL(value);
        if(url.origin!==value||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error();
        if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error();
        return {origin:url.origin,rpID:url.hostname};
    }catch(_){throw Error('ADMIN_PASSKEY_ORIGIN_INVALID');}
}
function publicCredential(key){return {id:key.id,remark:key.remark||'',rpID:key.rpID,createdAt:key.createdAt,lastUsedAt:key.lastUsedAt||0};}
function createAdminPasskeys({dataDir,marker,signingKey,now=Date.now,webauthn=()=>import('@simplewebauthn/server'),isSessionCurrent=()=>true}){
    const filename=path.join(dataDir,'.admin-passkeys.json'),flows=new Map();
    function load(){
        if(!fs.existsSync(filename))return [];
        const value=JSON.parse(fs.readFileSync(filename,'utf8'));
        if(value?.version!==1||!Array.isArray(value.credentials))throw Error('ADMIN_PASSKEY_STORE_INVALID');
        return value.credentials;
    }
    function save(credentials){
        fs.mkdirSync(dataDir,{recursive:true});const temporary=filename+'.'+process.pid+'.'+random()+'.tmp';
        try{fs.writeFileSync(temporary,JSON.stringify({version:1,credentials}),{mode:0o600});fs.renameSync(temporary,filename);}
        finally{try{fs.unlinkSync(temporary);}catch(_){}}
    }
    function active(){const stamp=marker();return stamp?load().filter(key=>key.marker===stamp):[];}
    function userHandle(){return crypto.createHmac('sha256',signingKey()).update('admin-passkey-user\0'+marker()).digest();}
    function put(flow){
        const at=now();for(const [id,value]of flows)if(value.expiresAt<=at)flows.delete(id);
        if(flows.size>=MAX_FLOWS)throw Error('ADMIN_PASSKEY_BUSY');
        const id=random();flows.set(id,{...flow,marker:marker(),expiresAt:at+FLOW_MS});return id;
    }
    function take(id,kind,origin,binding){
        const flow=flows.get(id);flows.delete(id);
        if(!flow||flow.kind!==kind||flow.expiresAt<=now()||flow.origin!==origin||flow.binding!==binding||flow.marker!==marker())throw Error('ADMIN_PASSKEY_FLOW_INVALID');
        return flow;
    }
    function requireBinding(binding){if(typeof binding!=='string'||binding.length<20||binding.length>200)throw Error('ADMIN_PASSKEY_BINDING_REQUIRED');}
    async function registrationOptions({origin,sessionId,remark=''}){
        requireBinding(sessionId);const info=originInfo(origin),stamp=marker();
        if(!isSessionCurrent(sessionId))throw Error('ADMIN_PASSKEY_SESSION_INVALID');
        if(!stamp)throw Error('ADMIN_PASSKEY_SETUP_REQUIRED');
        if(typeof remark!=='string'||remark.length>100||/[\u0000-\u001f\u007f]/.test(remark))throw Error('ADMIN_PASSKEY_REMARK_INVALID');
        const keys=active();if(keys.length>=MAX_KEYS)throw Error('ADMIN_PASSKEY_LIMIT');
        const methods=await webauthn(),options=await methods.generateRegistrationOptions({rpName:'Tunnel administrator',rpID:info.rpID,
            userID:userHandle(),userName:'administrator',userDisplayName:'Tunnel administrator',attestationType:'none',
            timeout:60000,authenticatorSelection:{residentKey:'preferred',userVerification:'required'},
            excludeCredentials:keys.filter(key=>key.rpID===info.rpID).map(key=>({id:key.id,transports:key.transports}))});
        if(marker()!==stamp||!isSessionCurrent(sessionId))throw Error('ADMIN_PASSKEY_FLOW_INVALID');
        return {flow_id:put({kind:'register',...info,binding:sessionId,challenge:options.challenge,remark:remark.trim()}),options};
    }
    async function register({origin,sessionId,flowId,response}){
        requireBinding(sessionId);const flow=take(flowId,'register',origin,sessionId),methods=await webauthn();
        if(!isSessionCurrent(sessionId))throw Error('ADMIN_PASSKEY_SESSION_INVALID');
        let result;
        try{result=await methods.verifyRegistrationResponse({response,expectedChallenge:flow.challenge,expectedOrigin:flow.origin,expectedRPID:flow.rpID,requireUserVerification:true});}
        catch(_){throw Error('ADMIN_PASSKEY_REGISTRATION_FAILED');}
        if(!result.verified||!result.registrationInfo?.credential||flow.marker!==marker()||flow.expiresAt<=now())throw Error('ADMIN_PASSKEY_REGISTRATION_FAILED');
        if(!isSessionCurrent(sessionId))throw Error('ADMIN_PASSKEY_SESSION_INVALID');
        const credentials=load(),credential=result.registrationInfo.credential;
        if(credentials.some(key=>key.id===credential.id))throw Error('ADMIN_PASSKEY_ALREADY_BOUND');
        if(credentials.filter(key=>key.marker===marker()).length>=MAX_KEYS)throw Error('ADMIN_PASSKEY_LIMIT');
        const key={id:credential.id,publicKey:Buffer.from(credential.publicKey).toString('base64'),counter:credential.counter,
            transports:credential.transports||[],marker:flow.marker,rpID:flow.rpID,remark:flow.remark,createdAt:now(),lastUsedAt:0};
        credentials.push(key);save(credentials);return publicCredential(key);
    }
    async function authenticationOptions({origin,binding}){
        requireBinding(binding);const info=originInfo(origin),stamp=marker(),keys=active().filter(key=>key.rpID===info.rpID);
        if(!keys.length)throw Error('ADMIN_PASSKEY_NOT_FOUND');
        const methods=await webauthn(),options=await methods.generateAuthenticationOptions({rpID:info.rpID,timeout:60000,userVerification:'required',
            allowCredentials:keys.map(key=>({id:key.id,transports:key.transports}))});
        if(marker()!==stamp)throw Error('ADMIN_PASSKEY_FLOW_INVALID');
        return {flow_id:put({kind:'authenticate',...info,binding,challenge:options.challenge}),options};
    }
    async function authenticate({origin,binding,flowId,response}){
        requireBinding(binding);const flow=take(flowId,'authenticate',origin,binding),keys=active();
        const key=keys.find(value=>value.id===response?.id&&value.rpID===flow.rpID);
        if(!key)throw Error('ADMIN_PASSKEY_AUTHENTICATION_FAILED');
        if(response.response?.userHandle&&response.response.userHandle!==userHandle().toString('base64url'))throw Error('ADMIN_PASSKEY_AUTHENTICATION_FAILED');
        const methods=await webauthn();let result;
        try{result=await methods.verifyAuthenticationResponse({response,expectedChallenge:flow.challenge,expectedOrigin:flow.origin,expectedRPID:flow.rpID,
            requireUserVerification:true,credential:{id:key.id,publicKey:new Uint8Array(Buffer.from(key.publicKey,'base64')),counter:key.counter,transports:key.transports}});}
        catch(_){throw Error('ADMIN_PASSKEY_AUTHENTICATION_FAILED');}
        if(!result.verified||flow.marker!==marker()||flow.expiresAt<=now())throw Error('ADMIN_PASSKEY_AUTHENTICATION_FAILED');
        const credentials=load(),current=credentials.find(value=>value.id===key.id&&value.marker===flow.marker),counter=result.authenticationInfo.newCounter;
        if(!current||(counter!==0||current.counter!==0)&&counter<=current.counter)throw Error('ADMIN_PASSKEY_AUTHENTICATION_FAILED');
        current.counter=counter;current.lastUsedAt=now();save(credentials);return publicCredential(current);
    }
    return {list:()=>active().map(publicCredential),registrationOptions,register,authenticationOptions,authenticate};
}
module.exports={createAdminPasskeys};
