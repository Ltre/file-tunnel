'use strict';

// HTTPS administrators must prove possession of a native DBSC registration key.
// Explicitly scoped loopback HTTP test sessions use TOTP without claiming DBSC.
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');

const COOKIE_NAME='__Host-tunnel_admin_session';
const PENDING_COOKIE='__Host-tunnel_admin_dbsc_pending';
// Chrome proactively refreshes DBSC credentials within two minutes of expiry.
// A two-minute cookie would therefore trigger refresh on almost every request.
const COOKIE_SECONDS=300;
const LOCAL_TEST_SECONDS=15*24*60*60;
const PENDING_MS=120000;
const SESSION_MS=7*24*60*60*1000;
const cleanId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{20,128}$/.test(value)?value:'';
const random=()=>crypto.randomBytes(32).toString('base64url');
const base64url=value=>Buffer.from(JSON.stringify(value)).toString('base64url');

function cookieValue(req,name){
    for(const part of String(req.headers.cookie||'').split(';')){
        const at=part.indexOf('=');if(at<0||part.slice(0,at).trim()!==name)continue;
        try{return decodeURIComponent(part.slice(at+1));}catch(_){return '';}
    }
    return '';
}
function cookie(name,value,seconds){return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;}
function parseStructuredString(value){
    const text=String(value||'').trim();
    if(text.length>8192)return '';
    if(text.startsWith('"')){try{return JSON.parse(text);}catch(_){return '';}}
    return text;
}
function verifyProof(token,expectedJwk,challenge,registration=false,{audience='',sessionId=''}={}){
    if(typeof token!=='string'||token.length>8192||!/^[-\w]+\.[-\w]+\.[-\w]+$/.test(token))return null;
    try{
        const [h,p,s]=token.split('.');
        const header=JSON.parse(Buffer.from(h,'base64url').toString('utf8'));
        const claims=JSON.parse(Buffer.from(p,'base64url').toString('utf8'));
        if(header.typ!=='dbsc+jwt'||!['ES256','RS256'].includes(header.alg)||claims.jti!==challenge)return null;
        if(!registration&&header.jwk!==undefined)return null;
        const payloadKey=claims.key;
        const modern=payloadKey!==undefined;
        // Chrome versions use both the original JWK-in-header format and the
        // newer W3C JWK-in-payload format. Never accept ambiguous key sources.
        if(registration&&Boolean(header.jwk)===modern)return null;
        if(modern){
            if(!payloadKey||typeof payloadKey!=='object'||payloadKey.d||
                !audience||claims.aud!==audience||!Number.isFinite(claims.iat)||
                Math.abs(Date.now()/1000-claims.iat)>600)return null;
            if(!registration&&claims.sub!==sessionId)return null;
        }
        if(claims.aud!==undefined&&claims.aud!==audience)return null;
        if(!registration&&claims.sub!==undefined&&claims.sub!==sessionId)return null;
        const jwk=registration?(modern?payloadKey:header.jwk):expectedJwk;
        if(!jwk||typeof jwk!=='object'||jwk.d)return null;
        if(header.alg==='ES256'&&(jwk.kty!=='EC'||jwk.crv!=='P-256')||header.alg==='RS256'&&jwk.kty!=='RSA')return null;
        if(!registration&&header.alg!==(jwk.kty==='EC'?'ES256':'RS256'))return null;
        const key=crypto.createPublicKey({key:jwk,format:'jwk'});
        if(header.alg==='RS256'&&key.asymmetricKeyDetails?.modulusLength<2048)return null;
        const good=crypto.verify('sha256',Buffer.from(h+'.'+p),
            {key,dsaEncoding:header.alg==='ES256'?'ieee-p1363':'der'},Buffer.from(s,'base64url'));
        if(!good)return null;
        if(!registration&&modern){
            const supplied=crypto.createPublicKey({key:payloadKey,format:'jwk'}).export({format:'jwk'});
            if(JSON.stringify(supplied)!==JSON.stringify(key.export({format:'jwk'})))return null;
        }
        // Retain only public parameters. Never persist caller-controlled JWK extras.
        return {jwk:key.export({format:'jwk'}),alg:header.alg};
    }catch(_){return null;}
}
function deviceInfo(agent){
    const ua=String(agent||'').slice(0,360);
    const os=/Windows NT ([\d.]+)/.exec(ua)?.[0]||/Android [\d.]+/.exec(ua)?.[0]||/iPhone OS [\d_]+/.exec(ua)?.[0]||/Mac OS X [\d_.]+/.exec(ua)?.[0]||(/Linux/.test(ua)?'Linux':'未知');
    const browser=/(?:Edg|OPR|Chrome|Firefox|Version)\/[\d.]+/.exec(ua)?.[0]||'未知';
    const model=/(?:Pixel|SM-[A-Z0-9]+|iPhone|iPad|Redmi|Mi )[^;) ]*/i.exec(ua)?.[0]||'未提供';
    return {model,os,browser,userAgent:ua};
}

function endpointAudience(req,route){
    const host=String(req.get?.('host')||req.headers?.host||'');
    if(!/^[\w.:[\]-]+$/.test(host))return '';
    const local=/^(?:localhost|127\.0\.0\.1|\[::1\])(?::|$)/i.test(host);
    const scheme=local&&req.protocol==='http'?'http':'https';
    return `${scheme}://${host}${route}`;
}

// This is a local development exception, never proof of a DBSC-bound device.
// Do not trust Host, req.ip, or forwarded headers as evidence of a local peer.
function localHttpTestAllowed(req){
    if(req.protocol!=='http')return false;
    const remote=String(req.socket?.remoteAddress||'').replace(/^::ffff:/i,'');
    if(remote!=='127.0.0.1'&&remote!=='::1')return false;
    const header=name=>req.get?.(name)||req.headers?.[name]||'';
    if(!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(header('host')))return false;
    if(Object.keys(req.headers||{}).some(name=>{
        const lower=name.toLowerCase();
        return lower==='forwarded'||lower.startsWith('x-forwarded-')||lower==='x-real-ip'||lower==='cf-connecting-ip';
    }))return false;
    const origin=header('origin');
    return !origin||origin===endpointAudience(req,'');
}

function createAdminDbscSessions({dataDir,signingKey,marker}){
    const filename=path.join(dataDir,'.admin-dbsc-sessions.json');
    const pending=new Map();
    function activity(session,address,at=Date.now()){
        session.ipActivity ||= session.address ? [{address:session.address,lastActivityAt:session.createdAt||0,legacy:true}] : [];
        const value=String(address||'');
        if(!value)return;
        const entry=session.ipActivity.find(item=>item.address===value);
        if(entry){entry.lastActivityAt=at;delete entry.legacy;}else session.ipActivity.push({address:value,lastActivityAt:at});
        session.lastActivityAt=at;
    }
    function load(){
        if(!fs.existsSync(filename))return [];
        const value=JSON.parse(fs.readFileSync(filename,'utf8'));
        if(!Array.isArray(value))throw Error('ADMIN_DBSC_SESSIONS_INVALID');
        return value;
    }
    function save(sessions){
        fs.mkdirSync(dataDir,{recursive:true});
        const temporary=filename+'.'+process.pid+'.'+random()+'.tmp';
        try{fs.writeFileSync(temporary,JSON.stringify(sessions),{mode:0o600});fs.renameSync(temporary,filename);}finally{try{fs.unlinkSync(temporary);}catch(_){}}
    }
    function sign(data){
        const payload=base64url(data);
        return payload+'.'+crypto.createHmac('sha256',signingKey()).update('admin-dbsc-cookie\0'+payload).digest('base64url');
    }
    function verify(req,touch=false){
        try{
            const token=cookieValue(req,COOKIE_NAME),parts=token.split('.');
            if(parts.length!==2||parts.some(part=>!/^[\w-]+$/.test(part)))return null;
            const expected=crypto.createHmac('sha256',signingKey()).update('admin-dbsc-cookie\0'+parts[0]).digest('base64url');
            if(parts[1].length!==expected.length||!crypto.timingSafeEqual(Buffer.from(parts[1]),Buffer.from(expected)))return null;
            const value=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
            if(!cleanId(value.sid)||value.exp<=Date.now()||value.marker!==marker())return null;
            const sessions=load(),session=sessions.find(entry=>entry.id===value.sid);
            if(!session||session.revokedAt||session.expiresAt<=Date.now()||session.marker!==value.marker)return null;
            if(value.exp>Date.now()+(session.localTest?LOCAL_TEST_SECONDS:COOKIE_SECONDS)*1000+1000)return null;
            if(session.localTest){
                if(!localHttpTestAllowed(req)||session.origin!==endpointAudience(req,''))return null;
            }else if(!session.boundAt)return null;
            if(touch){
                const address=String(session.localTest?req.socket?.remoteAddress:req.ip||'');
                const entry=session.ipActivity?.find(item=>item.address===address);
                if(!entry||Date.now()-entry.lastActivityAt>30000){activity(session,address);save(sessions);}
            }
            return session;
        }catch(_){return null;}
    }
    function begin(req,res){
        if(localHttpTestAllowed(req)){
            const now=Date.now(),session={id:random(),accountId:'administrator',marker:marker(),
                localTest:true,origin:endpointAudience(req,''),boundAt:0,createdAt:now,lastActivityAt:now,lastRefreshAt:0,
                expiresAt:now+LOCAL_TEST_SECONDS*1000,revokedAt:0,...deviceInfo(req.get?.('user-agent')||''),address:String(req.socket.remoteAddress)};
            activity(session,session.address,now);
            const sessions=load();sessions.push(session);save(sessions);
            res.setHeader('Set-Cookie',[cookie(PENDING_COOKIE,'',0),cookie(COOKIE_NAME,grant(session),LOCAL_TEST_SECONDS)]);
            res.setHeader('Cache-Control','no-store');
            return {authenticated:true,localTest:true,dbscRequired:false,expiresAt:session.expiresAt};
        }
        const now=Date.now();for(const [id,item] of pending)if(item.expiresAt<=now)pending.delete(id);
        if(pending.size>=500)throw Error('ADMIN_DBSC_PENDING_BUSY');
        const id=random(),challenge=random();
        pending.set(id,{challenge,expiresAt:now+PENDING_MS,agent:String(req.get?.('user-agent')||req.headers['user-agent']||''),address:String(req.ip||'')});
        res.setHeader('Set-Cookie',[cookie(PENDING_COOKIE,id,Math.ceil(PENDING_MS/1000)),cookie(COOKIE_NAME,'',0)]);
        res.setHeader('Secure-Session-Registration',`(ES256 RS256);path="/api/admin/auth/dbsc/register";challenge="${challenge}"`);
        res.setHeader('Cache-Control','no-store');
        return {pending:true,dbscRequired:true,expiresAt:now+PENDING_MS};
    }
    function instructions(id,req){
        // Keep scope and proof audience consistent. This URL calculation alone
        // does not imply native browser support: Chromium's network layer only
        // processes DBSC response headers over TLS with a valid certificate.
        const origin=endpointAudience(req,'');
        return {session_identifier:id,refresh_url:'/api/admin/auth/dbsc/refresh',scope:{origin,include_site:false,scope_specification:[]},
            credentials:[{type:'cookie',name:COOKIE_NAME,attributes:'Path=/; Secure; HttpOnly; SameSite=Strict'}]};
    }
    function grant(session){return sign({sid:session.id,exp:Date.now()+(session.localTest?LOCAL_TEST_SECONDS:COOKIE_SECONDS)*1000,marker:session.marker,nonce:random()});}
    function bindingStatus(req){
        // Only the browser holding this short-lived, TOTP-issued pending cookie
        // can observe its own registration progress. Never return challenges,
        // JWTs, public keys, another pending browser's data, or an auth grant.
        const item=pending.get(cookieValue(req,PENDING_COOKIE));
        if(!item)return null;
        return {state:item.expiresAt<=Date.now()?'expired':
            item.proofRejected?'registration-rejected':'awaiting-registration',expiresAt:item.expiresAt};
    }
    function register(req,res){
        const id=cookieValue(req,PENDING_COOKIE),item=pending.get(id);
        // Registration is a native browser request; no JS-provided public key
        // or device fingerprint is accepted in place of its signed DBSC JWT.
        if(!item||item.expiresAt<=Date.now())return null;
        const proof=verifyProof(parseStructuredString(req.get('Secure-Session-Response')),null,item.challenge,true,
            {audience:endpointAudience(req,'/api/admin/auth/dbsc/register')});
        if(!proof){item.proofRejected=true;return null;}
        pending.delete(id);
        const now=Date.now(),session={id:random(),accountId:'administrator',marker:marker(),publicKey:proof.jwk,algorithm:proof.alg,
            createdAt:now,boundAt:now,lastActivityAt:now,lastRefreshAt:now,expiresAt:now+SESSION_MS,revokedAt:0,
            ...deviceInfo(item.agent),address:item.address};
        activity(session,session.address,now);
        const sessions=load();sessions.push(session);save(sessions);
        res.setHeader('Set-Cookie',[cookie(PENDING_COOKIE,'',0),cookie(COOKIE_NAME,grant(session),COOKIE_SECONDS)]);
        res.setHeader('Cache-Control','no-store');
        return instructions(session.id,req);
    }
    function refresh(req,res){
        const id=cleanId(parseStructuredString(req.get('Sec-Secure-Session-Id')));
        if(!id)return {status:403};
        const sessions=load(),session=sessions.find(value=>value.id===id);
        if(!session||session.localTest||session.revokedAt||!session.boundAt||session.expiresAt<=Date.now()||session.marker!==marker())return {status:403};
        const proof=session.refreshChallenge&&verifyProof(parseStructuredString(req.get('Secure-Session-Response')),session.publicKey,session.refreshChallenge,false,
            {audience:endpointAudience(req,'/api/admin/auth/dbsc/refresh'),sessionId:id});
        if(proof&&session.refreshChallenge&&session.refreshChallengeAt+60000>Date.now()){
            session.refreshChallenge='';session.refreshChallengeAt=0;
            session.lastRefreshAt=Date.now();activity(session,req.ip);save(sessions);
            res.setHeader('Set-Cookie',cookie(COOKIE_NAME,grant(session),COOKIE_SECONDS));
            res.setHeader('Cache-Control','no-store');
            return {status:200,instructions:instructions(id,req)};
        }
        session.refreshChallenge=random();session.refreshChallengeAt=Date.now();save(sessions);
        res.setHeader('Secure-Session-Challenge',`"${session.refreshChallenge}";id="${id}"`);
        res.setHeader('Cache-Control','no-store');
        return {status:403};
    }
    function list(){return load().map(({publicKey,refreshChallenge,refreshChallengeAt,...session})=>({...session,
        ipActivity:session.ipActivity||(session.address?[{address:session.address,lastActivityAt:session.createdAt||0,legacy:true}]:[]),
        dbscBound:!session.localTest&&Boolean(session.boundAt)}));}
    function revoke(id){const sessions=load(),session=sessions.find(item=>item.id===id);if(!session)return false;if(!session.revokedAt){session.revokedAt=Date.now();save(sessions);}return true;}
    function revokeRequest(req){const session=verify(req);return session?revoke(session.id):false;}
    return {COOKIE_NAME,PENDING_COOKIE,COOKIE_SECONDS,begin,register,refresh,verify,list,revoke,revokeRequest,localHttpTestAllowed,bindingStatus,
        cookieHeader:(_req,value,seconds=COOKIE_SECONDS)=>cookie(COOKIE_NAME,value,seconds),_test:{verifyProof,sign,grant,load}};
}
module.exports={createAdminDbscSessions,verifyProof};
