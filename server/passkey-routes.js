'use strict';
const crypto=require('node:crypto');
const FLOW_COOKIE='__Host-disk_passkey_flow',COOKIE_PATH='/';
function installPasskeyRoutes(router,{auth,getIdentity,setIdentity,getOrigin,limiter,wrap}){
    const binding=req=>String(req.headers.cookie||'').split(';').map(value=>value.trim()).find(value=>value.startsWith(FLOW_COOKIE+'='))?.slice(FLOW_COOKIE.length+1)||'';
    const issue=(req,res)=>{const value=binding(req)||crypto.randomBytes(32).toString('base64url');res.cookie(FLOW_COOKIE,value,{httpOnly:true,secure:true,sameSite:'lax',path:COOKIE_PATH,maxAge:300000});return value;};
    const csrf=(req,res,next)=>{
        res.set('Cache-Control','no-store');
        if(req.method!=='GET'&&(!req.is('application/json')||req.get('Sec-Fetch-Site')==='cross-site'||req.get('Origin')&&req.get('Origin')!==getOrigin(req)))return res.status(403).json({error:'ORIGIN_MISMATCH'});
        next();
    };
    router.use('/passkeys',csrf);
    const identity=req=>{const user=getIdentity(req);if(!user)throw Error('LOGIN_REQUIRED');return user;};
    router.get('/passkeys',wrap((req,res)=>{const user=identity(req);res.json({identity:user,passkeys:auth.passkeys(user.id),origins:auth.passkeyOrigins()});}));
    router.patch('/passkeys/:id',limiter(),wrap((req,res)=>{
        const user=identity(req);auth.requireRecentAuthentication(user.id,req.diskSessionCookie,getOrigin(req));
        res.json({passkey:auth.renamePasskey(user.id,req.params.id,req.body?.remark)});
    }));
    router.post('/passkeys/choices',limiter(),wrap((req,res)=>res.json(auth.passkeyChoices({username:req.body?.username,origin:getOrigin(req)}))));
    router.post('/passkeys/handoff/start',limiter(),wrap((req,res)=>res.json(auth.startHandoff({username:req.body?.username,rpID:req.body?.rpID,origin:getOrigin(req),binding:issue(req,res),returnPath:req.body?.returnPath||'/'}))));
    router.get('/passkeys/handoff/info',limiter(),wrap((req,res)=>res.json(auth.handoffInfo(req.query.flow,getOrigin(req)))));
    router.post('/passkeys/handoff/cancel',wrap((req,res)=>{auth.cancelHandoff({id:req.body?.flow,origin:getOrigin(req),binding:binding(req)});res.json({ok:true});}));
    router.post('/passkeys/handoff/options',limiter(),wrap(async(req,res)=>res.json(await auth.handoffOptions({id:req.body?.flow,origin:getOrigin(req),binding:issue(req,res)}))));
    router.post('/passkeys/handoff/verify',limiter(),wrap(async(req,res)=>res.json(await auth.handoffVerify({flowId:req.body?.flow_id,response:req.body?.response,origin:getOrigin(req),binding:binding(req)}))));
    router.post('/passkeys/handoff/complete',limiter(),wrap((req,res)=>{
        const result=auth.completeHandoff({id:req.body?.flow,code:req.body?.code,origin:getOrigin(req),binding:binding(req)});
        setIdentity(req,res,result.identity);auth.rememberAuthentication(result.identity.id,req.diskSessionCookie,getOrigin(req));res.json(result);
    }));
}
module.exports={installPasskeyRoutes,FLOW_COOKIE,COOKIE_PATH};
