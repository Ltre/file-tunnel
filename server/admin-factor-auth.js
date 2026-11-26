'use strict';
// TOTP + administrator WebAuthn is a separate authentication domain. Browser
// preference remembers an observed/confirmed DBSC outcome, never an auth grant.
const crypto=require('node:crypto'),path=require('node:path'),fs=require('node:fs');
const {writeJson}=require('./disk-data');
const {requestOrigin}=require('./admin-request-context');
const {createAdminPasskeys}=require('./admin-passkeys');
const {deviceInfo}=require('./admin-dbsc-sessions');
const DEVICE='__Host-tunnel_admin_device',PENDING='__Host-tunnel_admin_totp',SESSION='__Host-tunnel_admin_factors';
const DAY=86400000,PENDING_MS=5*60000,PROBE_MS=5000;
const random=()=>crypto.randomBytes(32).toString('base64url');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const readJson=(filename,fallback)=>{try{return JSON.parse(fs.readFileSync(filename,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}};
const readCookie=(req,name)=>String(req.headers?.cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith(name+'='))?.slice(name.length+1)||'';
function appendCookie(res,name,value,seconds,secure=true){
    const previous=res.getHeader?.('Set-Cookie')||res.headers?.['Set-Cookie']||[];
    res.setHeader('Set-Cookie',[...(Array.isArray(previous)?previous:[previous]),`${name}=${value}; Path=/;${secure?' Secure;':''} HttpOnly; SameSite=Strict; Max-Age=${seconds}`]);
}
function addMonths(at,count){const result=new Date(at),day=result.getUTCDate();result.setUTCDate(1);result.setUTCMonth(result.getUTCMonth()+count);const end=new Date(result);end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);result.setUTCDate(Math.min(day,end.getUTCDate()));return result.getTime();}
function createAdminFactorAuth({dataDir,marker,signingKey,dbsc,now=Date.now,webauthn}){
    const filename=path.join(dataDir,'.admin-factor-sessions.json'),policyFile=path.join(dataDir,'.admin-factor-policy.json'),pending=new Map();
    const load=()=>{const data=readJson(filename,{version:1,devices:[],sessions:[]});if(data.version!==1||!Array.isArray(data.devices)||!Array.isArray(data.sessions))throw Error('ADMIN_FACTOR_STORE_INVALID');return data;};
    const save=value=>writeJson(filename,value);
    function policy(){const value=readJson(policyFile,{totpMonths:3,passkeyDays:7,revision:'initial'});if(!validPolicy(value))throw Error('ADMIN_FACTOR_POLICY_INVALID');return value;}
    function validPolicy(value){return Number.isInteger(value.totpMonths)&&value.totpMonths>=1&&value.totpMonths<=24&&Number.isInteger(value.passkeyDays)&&value.passkeyDays>=1&&value.passkeyDays<value.totpMonths*28;}
    const deadlines=session=>{const value=policy();return{totpExpiresAt:Math.min(session.totpLimit||Infinity,addMonths(session.totpVerifiedAt,value.totpMonths)),passkeyExpiresAt:Math.min(session.passkeyLimit||Infinity,session.passkeyVerifiedAt+value.passkeyDays*DAY)};};
    function browser(req){const secret=readCookie(req,DEVICE);return secret&&load().devices.find(value=>value.secretHash===hash(secret)&&value.marker===marker()&&value.origin===requestOrigin(req));}
    function ensureBrowser(req,res){let value=browser(req);if(value)return value;const secret=random();value={id:random(),secretHash:hash(secret),mode:'unknown',origin:requestOrigin(req),marker:marker(),createdAt:now()};const data=load();data.devices.push(value);save(data);appendCookie(res,DEVICE,secret,2*366*86400);return value;}
    function preauth(req){const token=readCookie(req,PENDING),item=token&&pending.get(hash(token)),device=browser(req);return item&&device&&item.deviceId===device.id&&item.origin===requestOrigin(req)&&item.marker===marker()&&item.expiresAt>now()?item:null;}
    function rawSession(req){const token=readCookie(req,SESSION),device=browser(req);if(!token||!device||device.mode!=='passkey')return null;const value=load().sessions.find(entry=>entry.secretHash===hash(token)&&entry.deviceId===device.id&&entry.origin===requestOrigin(req)&&entry.marker===marker()&&!entry.revokedAt);return value&&deadlines(value).totpExpiresAt>now()?value:null;}
    function currentRegistration(id){
        const active=load().sessions.find(value=>value.id===id&&value.marker===marker()&&!value.revokedAt);
        if(active){const dates=deadlines(active);return dates.totpExpiresAt>now()&&dates.passkeyExpiresAt>now();}
        const initial=[...pending.values()].find(value=>value.id===id&&value.marker===marker()&&value.expiresAt>now()&&value.stage==='passkey');
        if(initial)return keys.list().length===0&&load().devices.some(device=>device.id===initial.deviceId&&device.mode==='passkey');
        return dbsc.list().some(value=>value.id===id&&value.marker===marker()&&!value.revokedAt&&value.expiresAt>now()&&(value.dbscBound||value.localTest));
    }
    const keys=createAdminPasskeys({dataDir,marker,signingKey,now,...webauthn?{webauthn}:{},isSessionCurrent:currentRegistration});
    function begin(req,res){
        if(dbsc.localHttpTestAllowed(req))return dbsc.begin(req,res);
        const remembered=browser(req);
        const result=remembered?.mode==='passkey'?{pending:true,dbscRequired:false}:dbsc.begin(req,res);
        const device=ensureBrowser(req,res),token=random(),at=now();
        for(const [id,value]of pending)if(value.expiresAt<=at||value.deviceId===device.id)pending.delete(id);
        if(pending.size>=500)throw Error('ADMIN_FACTOR_BUSY');
        const item={id:random(),deviceId:device.id,origin:requestOrigin(req),marker:marker(),totpVerifiedAt:at,expiresAt:at+PENDING_MS,stage:device.mode==='passkey'?'passkey':'dbsc',nativeReceived:false};
        // Native registration remains the first choice until this browser has
        // explicitly confirmed it cannot use it. No operating-system test.
        pending.set(hash(token),item);appendCookie(res,PENDING,token,PENDING_MS/1000);
        return {...result,factorRequired:item.stage==='passkey',enrollmentRequired:item.stage==='passkey'&&!keys.list().length};
    }
    function status(req){
        const device=browser(req),item=preauth(req),session=rawSession(req);
        return {browserMode:device?.mode||'unknown',totpRequired:!item&&!session,
            passkeyRequired:Boolean(session&&deadlines(session).passkeyExpiresAt<=now()||item?.stage==='passkey'),
            enrollmentRequired:Boolean(item?.stage==='passkey'&&!keys.list().length),
            fallbackAllowed:Boolean(item?.stage==='dbsc'&&!item.nativeReceived&&now()-item.totpVerifiedAt>=PROBE_MS&&device?.mode!=='dbsc'),
            ...session?deadlines(session):{}};
    }
    function fallback(req){
        const item=preauth(req),device=browser(req);
        if(!item||!device||!status(req).fallbackAllowed||dbsc.verify(req))throw Error('ADMIN_DBSC_FALLBACK_DENIED');
        const data=load();data.devices.find(value=>value.id===device.id).mode='passkey';save(data);item.stage='passkey';
        return {ok:true,...status(req)};
    }
    function registerNative(req,res){
        const item=preauth(req);if(item)item.nativeReceived=true;
        const instructions=dbsc.register(req,res);if(!instructions)return null;
        const device=ensureBrowser(req,res),data=load();data.devices.find(value=>value.id===device.id).mode='dbsc';save(data);
        if(item)pending.delete(hash(readCookie(req,PENDING)));appendCookie(res,PENDING,'',0);
        return instructions;
    }
    function verify(req,touch=false){
        const value=rawSession(req);if(!value||deadlines(value).passkeyExpiresAt<=now())return null;
        if(touch){const address=String(req.ip||req.socket?.remoteAddress||''),data=load(),session=data.sessions.find(entry=>entry.id===value.id),last=session.ipActivity.find(entry=>entry.address===address);
            if(!last||last.lastActivityAt+30000<=now()){if(last)last.lastActivityAt=now();else session.ipActivity.push({address,lastActivityAt:now()});session.lastActivityAt=now();save(data);}}
        return {...value,...deadlines(value),expiresAt:deadlines(value).totpExpiresAt,independentAuth:true,authMethod:'totp-passkey',dbscBound:false};
    }
    function liveContext(req){const item=preauth(req),session=rawSession(req);if(item?.stage==='passkey')return item;if(session)return session;throw Error('ADMIN_TOTP_REQUIRED');}
    function assertContext(req,context){const latest=liveContext(req);if(latest.id!==context.id||browser(req)?.mode!=='passkey')throw Error('ADMIN_PASSKEY_SESSION_INVALID');}
    function finish(req,res,context,credential){
        assertContext(req,context);const data=load();let session=data.sessions.find(value=>value.id===context.id);
        if(session){session.passkeyVerifiedAt=now();session.passkeyLimit=now()+policy().passkeyDays*DAY;session.credentialId=credential.id;save(data);}
        else {const secret=random();for(const previous of data.sessions)if(previous.deviceId===context.deviceId&&!previous.revokedAt)previous.revokedAt=now();session={id:random(),secretHash:hash(secret),deviceId:context.deviceId,marker:marker(),origin:requestOrigin(req),totpVerifiedAt:context.totpVerifiedAt,passkeyVerifiedAt:now(),credentialId:credential.id,
            totpLimit:addMonths(context.totpVerifiedAt,policy().totpMonths),passkeyLimit:now()+policy().passkeyDays*DAY,
            createdAt:now(),lastActivityAt:now(),revokedAt:0,...deviceInfo(req.get?.('user-agent')||''),ipActivity:[{address:String(req.ip||req.socket?.remoteAddress||''),lastActivityAt:now()}]};data.sessions.push(session);save(data);appendCookie(res,SESSION,secret,Math.max(0,Math.ceil((deadlines(session).totpExpiresAt-now())/1000)));}
        pending.delete(hash(readCookie(req,PENDING)));appendCookie(res,PENDING,'',0);return {authenticated:true,independentAuth:true,...deadlines(session)};
    }
    function revoke(id){const data=load(),value=data.sessions.find(entry=>entry.id===id);if(!value)return false;value.revokedAt=now();save(data);return true;}
    function list(){return load().sessions.filter(value=>value.marker===marker()).map(({secretHash,deviceId,...value})=>({...value,...deadlines(value),expiresAt:deadlines(value).totpExpiresAt,independentAuth:true,authMethod:'totp-passkey',dbscBound:false}));}
    function logout(req,res){const item=rawSession(req);if(item)revoke(item.id);pending.delete(hash(readCookie(req,PENDING)));appendCookie(res,SESSION,'',0);appendCookie(res,PENDING,'',0);appendCookie(res,'tunnel_admin_local_test','',0,false);}
    function installRoutes(app,{requireAuth,rateLimit}){
        const csrf=(req,res,next)=>{res.setHeader('Cache-Control','no-store');if(req.method!=='GET'&&(!req.is('application/json')||req.get('sec-fetch-site')==='cross-site'||req.get('origin')&&req.get('origin')!==requestOrigin(req)))return res.status(403).json({error:'ADMIN_ORIGIN_MISMATCH'});next();};
        const run=handler=>async(req,res)=>{try{res.json(await handler(req,res));}catch(error){res.status(403).json({error:/^ADMIN_/.test(error.message)?error.message:'ADMIN_PASSKEY_FAILED'});}};
        app.post('/api/admin/auth/dbsc-unavailable',rateLimit,csrf,run(req=>{if(req.body?.confirmed!==true)throw Error('ADMIN_DBSC_CONFIRM_REQUIRED');return fallback(req);}));
        app.post('/api/admin/auth/passkey/options',rateLimit,csrf,run(req=>{const context=liveContext(req);return keys.authenticationOptions({origin:requestOrigin(req),binding:context.id});}));
        app.post('/api/admin/auth/passkey/verify',rateLimit,csrf,run(async(req,res)=>{const context=liveContext(req),credential=await keys.authenticate({origin:requestOrigin(req),binding:context.id,flowId:req.body?.flow_id,response:req.body?.response});return finish(req,res,context,credential);}));
        // Initial enrollment has only TOTP + explicit unsupported-browser
        // context. It is not admitted to any general administrator endpoint.
        app.post('/api/admin/auth/passkey/register/options',rateLimit,csrf,run(req=>{const context=liveContext(req);if(context.stage!=='passkey'||keys.list().length)throw Error('ADMIN_PASSKEY_AUTHENTICATION_REQUIRED');return keys.registrationOptions({origin:requestOrigin(req),sessionId:context.id,remark:req.body?.remark});}));
        app.post('/api/admin/auth/passkey/register/verify',rateLimit,csrf,run(async(req,res)=>{const context=liveContext(req);if(context.stage!=='passkey'||keys.list().length)throw Error('ADMIN_PASSKEY_AUTHENTICATION_REQUIRED');const credential=await keys.register({origin:requestOrigin(req),sessionId:context.id,flowId:req.body?.flow_id,response:req.body?.response});return finish(req,res,context,credential);}));
        app.get('/api/admin/security/passkeys',requireAuth,csrf,run(()=>({passkeys:keys.list()})));
        app.post('/api/admin/security/passkeys/register/options',requireAuth,rateLimit,csrf,run(req=>{const session=dbsc.verify(req)||verify(req);return keys.registrationOptions({origin:requestOrigin(req),sessionId:session.id,remark:req.body?.remark});}));
        app.post('/api/admin/security/passkeys/register/verify',requireAuth,rateLimit,csrf,run(async req=>{const session=dbsc.verify(req)||verify(req);return {ok:true,passkey:await keys.register({origin:requestOrigin(req),sessionId:session.id,flowId:req.body?.flow_id,response:req.body?.response})};}));
        app.get('/api/admin/security/auth-policy',requireAuth,csrf,run(()=>policy()));
        app.put('/api/admin/security/auth-policy',requireAuth,rateLimit,csrf,run(req=>{
            const next={totpMonths:req.body?.totpMonths,passkeyDays:req.body?.passkeyDays};
            if(!validPolicy(next))throw Error('ADMIN_FACTOR_POLICY_INVALID');
            if(req.body?.revision!==policy().revision)throw Error('ADMIN_FACTOR_POLICY_CONFLICT');
            const data=load();
            // Shortening applies immediately. Remember that bound so a later
            // extension cannot resurrect a credential that already expired.
            for(const session of data.sessions){session.totpLimit=Math.min(session.totpLimit||Infinity,addMonths(session.totpVerifiedAt,next.totpMonths));session.passkeyLimit=Math.min(session.passkeyLimit||Infinity,session.passkeyVerifiedAt+next.passkeyDays*DAY);}
            save(data);const value={...next,revision:random()};writeJson(policyFile,value);return value;
        }));
    }
    return {begin,status,registerNative,verify,list,revoke,logout,installRoutes,keys,policy,_test:{fallback,finish,liveContext,load,addMonths}};
}
module.exports={createAdminFactorAuth,addMonths};
