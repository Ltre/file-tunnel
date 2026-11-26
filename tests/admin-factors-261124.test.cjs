'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createAdminFactorAuth,addMonths}=require('../server/admin-factor-auth');
const {createAdminDbscSessions}=require('../server/admin-dbsc-sessions');
const {localTestAllowed}=require('../server/admin-request-context');
const authenticator=require('./support/passkey-authenticator.cjs');
const DAY=86400000,origin='https://admin.test';
function fixture(t){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-factors-261124-'));let at=Date.now(),stamp='totp-identity',jar={};
    t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('admin-factors-261124-'));fs.rmSync(dir,{recursive:true,force:true});});
    const options={dataDir:dir,signingKey:()=> 'fixture-only-admin-factor-key',marker:()=>stamp};
    const dbsc=createAdminDbscSessions(options);let factors=createAdminFactorAuth({...options,dbsc,now:()=>at});
    const req=(headers={})=>{const values={host:'admin.test',cookie:Object.entries(jar).map(([k,v])=>k+'='+v).join(';'),...headers};return{headers:values,get:name=>values[name.toLowerCase()]||'',protocol:'https',ip:'10.0.0.3',socket:{remoteAddress:'10.0.0.3',localAddress:'10.0.0.1'}};};
    const res=()=>({headers:{},getHeader(name){return this.headers[name];},setHeader(name,value){this.headers[name]=value;}});
    const accept=response=>{for(const value of response.headers['Set-Cookie']||[]){const part=value.split(';')[0],index=part.indexOf('='),name=part.slice(0,index),data=part.slice(index+1);if(/Max-Age=0(?:;|$)/.test(value))delete jar[name];else jar[name]=data;}};
    const begin=()=>{const response=res(),result=factors.begin(req(),response);accept(response);return result;};
    return{dir,options,dbsc,req,res,accept,begin,get auth(){return factors;},get jar(){return jar;},set jar(value){jar=value;},advance:value=>{at+=value;},get now(){return at;},set marker(value){stamp=value;},restart(){factors=createAdminFactorAuth({...options,dbsc,now:()=>at});}};
}
async function enroll(f){
    assert.equal(f.begin().dbscRequired,true);assert.equal(f.auth.verify(f.req()),null);
    assert.throws(()=>f.auth._test.fallback(f.req()),/FALLBACK_DENIED/);f.advance(6000);
    assert.equal(f.auth.status(f.req()).fallbackAllowed,true);f.auth._test.fallback(f.req());
    const pending=f.auth._test.liveContext(f.req()),key=authenticator('admin.test');
    const options=await f.auth.keys.registrationOptions({origin,sessionId:pending.id,remark:'独立管理员设备'});
    assert.equal(f.auth.verify(f.req()),null,'首绑前 TOTP 不能访问后台');
    const credential=await f.auth.keys.register({origin,sessionId:pending.id,flowId:options.flow_id,response:key.register(options,origin)});
    const response=f.res();f.auth._test.finish(f.req(),response,pending,credential);f.accept(response);return key;
}
async function verifyKey(f,key){const context=f.auth._test.liveContext(f.req()),options=await f.auth.keys.authenticationOptions({origin,binding:context.id});key.counter=(key.counter||0)+1;const credential=await f.auth.keys.authenticate({origin,binding:context.id,flowId:options.flow_id,response:key.login(options,key.counter,origin)});const response=f.res();const result=f.auth._test.finish(f.req(),response,context,credential);f.accept(response);return result;}
test('管理员首绑前拒绝访问，真实 WebAuthn 后三个月 TOTP 与七天 Passkey 必须同时有效',async t=>{
    const f=fixture(t),key=await enroll(f),first=f.auth.verify(f.req(),true);
    assert.equal(first.independentAuth,true);assert.equal(first.dbscBound,false);assert.equal(first.passkeyExpiresAt,f.now+7*DAY);
    assert.equal(first.totpExpiresAt,addMonths(first.totpVerifiedAt,3));
    const originalTotp=first.totpVerifiedAt,oldJar={...f.jar};f.advance(7*DAY+1);
    assert.equal(f.auth.verify(f.req()),null);assert.equal(f.auth.status(f.req()).totpRequired,false);assert.equal(f.auth.status(f.req()).passkeyRequired,true);
    await verifyKey(f,key);assert.equal(f.auth.verify(f.req()).totpVerifiedAt,originalTotp,'每周仅补验 Passkey，不重置 TOTP 时限');
    f.jar={__Host_tunnel_admin_factors:'wrong'};assert.equal(f.auth.verify(f.req()),null);
    f.jar={'__Host-tunnel_admin_factors':oldJar['__Host-tunnel_admin_factors']};assert.equal(f.auth.verify(f.req()),null,'会话必须同时绑定浏览器标记');
    f.jar=oldJar;assert.equal(f.auth.verify(f.req({host:'other.test'})),null);
    f.advance(first.totpExpiresAt-f.now+1);assert.equal(f.auth.verify(f.req()),null);assert.equal(f.auth.status(f.req()).totpRequired,true);
    assert.throws(()=>f.auth._test.liveContext(f.req()),/TOTP_REQUIRED/);
    assert.equal(f.begin().factorRequired,true,'已记住不支持，不再按 UA 重试 DBSC');await verifyKey(f,key);assert.ok(f.auth.verify(f.req()));
});
test('新浏览器、撤销、管理员身份重设、过期及重放都不能沿用旧授权；重启保留模式与会话',async t=>{
    const f=fixture(t),key=await enroll(f),saved={...f.jar};f.restart();assert.ok(f.auth.verify(f.req()));assert.equal(f.auth.status(f.req()).browserMode,'passkey');
    const context=f.auth._test.liveContext(f.req()),flow=await f.auth.keys.authenticationOptions({origin,binding:context.id});
    f.auth.revoke(context.id);assert.equal(f.auth.verify(f.req()),null);
    const credential=await f.auth.keys.authenticate({origin,binding:context.id,flowId:flow.flow_id,response:key.login(flow,1,origin)});
    assert.throws(()=>f.auth._test.finish(f.req(),f.res(),context,credential),/TOTP_REQUIRED/);
    f.jar={};assert.equal(f.begin().dbscRequired,true);f.advance(6000);f.auth._test.fallback(f.req());
    assert.equal(f.auth.status(f.req()).enrollmentRequired,false,'已有管理员凭据时新设备必须验证，不能仅 TOTP 添加新凭据');
    const pending=f.auth._test.liveContext(f.req());await assert.rejects(f.auth.keys.registrationOptions({origin,sessionId:pending.id}),/SESSION_INVALID/);
    f.advance(5*60000);assert.throws(()=>f.auth._test.liveContext(f.req()),/TOTP_REQUIRED/);
    f.jar=saved;f.marker='new-totp-identity';assert.equal(f.auth.verify(f.req()),null);assert.deepEqual(f.auth.keys.list(),[]);
});
test('曾在当前浏览器成功原生 DBSC 绑定后，不允许降级；无效注册也不被当作未支持',t=>{
    const f=fixture(t);f.begin();const pair=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'}),pending=f.dbsc.bindingStatus(f.req());assert.ok(pending);
    f.advance(6000);const response=f.res();assert.equal(f.auth.registerNative(f.req(),response),null);
    assert.equal(f.auth.status(f.req()).fallbackAllowed,false,'服务端收到无效证明时不能降级');
    // Issue a fresh native pending proof using the real DBSC JWT verifier.
    const out=f.res();f.auth.begin(f.req(),out);f.accept(out);
    const challenge=/challenge="([^"]+)"/.exec(out.headers['Secure-Session-Registration'])[1];
    const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');const unsigned=encode({typ:'dbsc+jwt',alg:'ES256'})+'.'+encode({jti:challenge,aud:origin+'/api/admin/auth/dbsc/register',iat:Math.floor(Date.now()/1000),key:pair.publicKey.export({format:'jwk'})});
    const token=unsigned+'.'+crypto.sign('sha256',Buffer.from(unsigned),{key:pair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
    const registered=f.res();assert.ok(f.auth.registerNative(f.req({'secure-session-response':token}),registered));f.accept(registered);
    assert.equal(f.auth.status(f.req()).browserMode,'dbsc');
    f.begin();f.advance(6000);assert.throws(()=>f.auth._test.fallback(f.req()),/FALLBACK_DENIED/);
});
test('局域网 IP 测试必须是真实私网直连，公网域名/代理头/伪造 Host 不享受例外',()=>{
    const req=(host,remote='192.168.1.4',local='192.168.1.2',extra={})=>({headers:{host,...extra},protocol:'http',socket:{remoteAddress:remote,localAddress:local}});
    assert.equal(localTestAllowed(req('192.168.1.2:80')),true);
    for(const value of [req('public.example'),req('192.168.1.2','203.0.113.1'),req('192.168.1.2','192.168.1.4','10.0.0.1'),req('192.168.1.2','192.168.1.4','192.168.1.2',{'x-forwarded-proto':'http'}),req('192.168.1.2','192.168.1.4','192.168.1.2',{origin:'http://evil.example'})])assert.equal(localTestAllowed(value),false);
    assert.equal(localTestAllowed(req('localhost','127.0.0.1','127.0.0.1')),true);
    assert.equal(localTestAllowed({...req('localhost','127.0.0.1','127.0.0.1'),protocol:'https'}),false,'保留 HTTPS localhost 的原生安全流程');
});
