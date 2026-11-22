'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),os=require('node:os'),fs=require('node:fs'),path=require('node:path');
const {createAdminAuth}=require('../server/admin-auth');
const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt=(key,claims,registration)=>{const header={typ:'dbsc+jwt',alg:'ES256',...(registration?{jwk:key.publicKey.export({format:'jwk'})}:{})};const body=b64(header)+'.'+b64(claims);return body+'.'+crypto.sign('sha256',Buffer.from(body),{key:key.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');};
const modernJwt=(pair,claims)=>{const header={typ:'dbsc+jwt',alg:'ES256'};
    const payload={...claims,iat:Math.floor(Date.now()/1000),key:pair.publicKey.export({format:'jwk'})};
    const body=b64(header)+'.'+b64(payload);
    return body+'.'+crypto.sign('sha256',Buffer.from(body),{key:pair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');};
const makeRes=()=>({headers:{},setHeader(key,value){this.headers[key]=value;}});
const makeReq=(headers={})=>({headers,get(name){return this.headers[name.toLowerCase()]||'';},ip:'127.0.0.1'});
const cookieFrom=(res,name)=>[].concat(res.headers['Set-Cookie']||[]).find(value=>value.startsWith(name+'='))?.split(';')[0]||'';

test('admin TOTP registration requires signed DBSC device key; refresh and revocation take effect immediately',t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-dbsc-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    fs.writeFileSync(path.join(dir,'.gauth-admin.json'),JSON.stringify({secret:'JBSWY3DPEHPK3PXP',createdAt:'fixture'}));
    const auth=createAdminAuth({dataDir:dir}),pair=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'});
    const startRes=makeRes(),start=auth.beginBinding(makeReq({'user-agent':'Mozilla/5.0 Chrome/150 Windows NT 10.0'}),startRes);
    assert.equal(start.dbscRequired,true);
    assert.equal(auth.isAuthenticated(makeReq({cookie:cookieFrom(startRes,'__Host-tunnel_admin_dbsc_pending')})),false);
    const challenge=/challenge="([^"]+)"/.exec(startRes.headers['Secure-Session-Registration'])[1];
    const pending=cookieFrom(startRes,'__Host-tunnel_admin_dbsc_pending');
    assert.equal(auth.registerDbsc(makeReq({cookie:pending,'secure-session-response':jwt(pair,{jti:'forged'},true)}),makeRes()),null);
    const registerRes=makeRes(),registration=auth.registerDbsc(makeReq({cookie:pending,host:'example.com','secure-session-response':jwt(pair,{jti:challenge},true)}),registerRes);
    assert.match(registration.refresh_url,/dbsc\/refresh/);
    const granted=cookieFrom(registerRes,'__Host-tunnel_admin_session');
    assert.ok([].concat(registerRes.headers['Set-Cookie']).some(value=>value.startsWith(granted)&&value.includes('Max-Age=300')),'native DBSC cookie remains short-lived');
    assert.equal(auth.isAuthenticated(makeReq({cookie:granted})),true);
    const reconstructed=createAdminAuth({dataDir:dir});
    assert.equal(reconstructed.isAuthenticated(makeReq({cookie:granted})),true);
    const session=auth.getSession(makeReq({cookie:granted}));
    assert.equal(auth.sessions().length,1);
    assert.equal(auth.sessions()[0].dbscBound,true);
    assert.equal(auth.sessions()[0].publicKey,undefined);
    const refreshRes=makeRes(),initial=auth.refreshDbsc(makeReq({'sec-secure-session-id':'"'+session.id+'"'}),refreshRes);
    assert.equal(initial.status,403);
    const challenge2=/^"([^"]+)"/.exec(refreshRes.headers['Secure-Session-Challenge'])[1];
    const freshRes=makeRes(),fresh=auth.refreshDbsc(makeReq({'sec-secure-session-id':'"'+session.id+'"','secure-session-response':jwt(pair,{jti:challenge2},false),host:'example.com'}),freshRes);
    assert.equal(fresh.status,200);
    assert.ok(cookieFrom(freshRes,'__Host-tunnel_admin_session'));
    assert.equal(auth.revokeSession(session.id),true);
    assert.equal(auth.isAuthenticated(makeReq({cookie:granted})),false);
    assert.equal(auth.refreshDbsc(makeReq({'sec-secure-session-id':'"'+session.id+'"'}),makeRes()).status,403);
});

test('admin DBSC accepts the current payload-key proof format and validates URL and session identity',t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-dbsc-modern-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    fs.writeFileSync(path.join(dir,'.gauth-admin.json'),JSON.stringify({secret:'JBSWY3DPEHPK3PXP',createdAt:'fixture'}));
    const auth=createAdminAuth({dataDir:dir}),pair=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'});
    const startRes=makeRes();auth.beginBinding(makeReq({host:'example.com'}),startRes);
    const pending=cookieFrom(startRes,'__Host-tunnel_admin_dbsc_pending');
    const challenge=/challenge="([^"]+)"/.exec(startRes.headers['Secure-Session-Registration'])[1];
    const regUrl='https://example.com/api/admin/auth/dbsc/register';
    const regReq=proof=>makeReq({cookie:pending,host:'example.com','secure-session-response':proof});
    assert.equal(auth.registerDbsc(regReq(modernJwt(pair,{jti:challenge,aud:'https://evil.example/api/admin/auth/dbsc/register'})),makeRes()),null);
    const registerRes=makeRes();const instructions=auth.registerDbsc(regReq(modernJwt(pair,{jti:challenge,aud:regUrl})),registerRes);
    assert.equal(instructions?.session_identifier?.length>20,true);
    const id=instructions.session_identifier;
    const firstRes=makeRes();assert.equal(auth.refreshDbsc(makeReq({'sec-secure-session-id':`"${id}"`}),firstRes).status,403);
    const nextChallenge=/^"([^"]+)"/.exec(firstRes.headers['Secure-Session-Challenge'])[1];
    const refreshUrl='https://example.com/api/admin/auth/dbsc/refresh';
    const refreshReq=proof=>makeReq({host:'example.com','sec-secure-session-id':`"${id}"`,'secure-session-response':proof});
    const badRes=makeRes();
    assert.equal(auth.refreshDbsc(refreshReq(modernJwt(pair,{jti:nextChallenge,aud:refreshUrl,sub:'wrong-session'})),badRes).status,403);
    const renewedChallenge=/^"([^"]+)"/.exec(badRes.headers['Secure-Session-Challenge'])[1];
    assert.equal(auth.refreshDbsc(refreshReq(modernJwt(pair,{jti:renewedChallenge,aud:refreshUrl,sub:id})),makeRes()).status,200);
});

// These direct calls exercise URL construction, not a native browser's TLS gate.
test('admin DBSC scope and proof audience use the same origin in synthetic requests',t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-dbsc-localhost-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    fs.writeFileSync(path.join(dir,'.gauth-admin.json'),JSON.stringify({secret:'JBSWY3DPEHPK3PXP',createdAt:'fixture'}));
    const auth=createAdminAuth({dataDir:dir}),pair=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'});
    for(const [host,protocol,origin] of [
        ['localhost','http','http://localhost'],
        ['127.0.0.1:3000','http','http://127.0.0.1:3000'],
        ['localhost','https','https://localhost'],
        ['example.com','http','https://example.com']
    ]){
        const request=makeReq({host});request.protocol=protocol;
        const startResponse=makeRes();auth.beginBinding(request,startResponse);
        const pending=cookieFrom(startResponse,'__Host-tunnel_admin_dbsc_pending');
        const challenge=/challenge="([^"]+)"/.exec(startResponse.headers['Secure-Session-Registration'])[1];
        const registerRequest=makeReq({host,cookie:pending,'secure-session-response':modernJwt(pair,{
            jti:challenge,aud:origin+'/api/admin/auth/dbsc/register'
        })});registerRequest.protocol=protocol;
        const instructions=auth.registerDbsc(registerRequest,makeRes());
        assert.equal(instructions?.scope.origin,origin,host+' scope origin');
    }
});
