'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAdminPasskeys}=require('../server/admin-passkeys');
const authenticator=require('./support/passkey-authenticator.cjs');
const origin='https://admin.test',sessionId='fixture-admin-session-identity-261123',binding='fixture-browser-login-binding-261123';
function fixture(t){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-passkeys-261123-'));let marker='fixture-admin-totp-setup',at=Date.now();
    t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('admin-passkeys-261123-'));fs.rmSync(dir,{recursive:true,force:true});});
    const options={dataDir:dir,marker:()=>marker,signingKey:()=>Buffer.from('independent-administrator-secret-key'),now:()=>at};
    return {auth:createAdminPasskeys(options),options,dir,marker(value){marker=value;},advance(ms){at+=ms;}};
}
async function register(f,key=authenticator('admin.test')){
    const flow=await f.auth.registrationOptions({origin,sessionId,remark:'手机管理员钥匙'});
    const saved=await f.auth.register({origin,sessionId,flowId:flow.flow_id,response:key.register(flow,origin)});
    return {key,saved};
}
test('independent admin Passkeys require real WebAuthn signatures and persist only their own credentials',async t=>{
    const f=fixture(t),{key,saved}=await register(f);
    assert.equal(saved.remark,'手机管理员钥匙');assert.equal(saved.rpID,'admin.test');assert.equal(saved.lastUsedAt,0);
    assert.deepEqual(Object.keys(saved).sort(),['createdAt','id','lastUsedAt','remark','rpID']);
    assert.deepEqual(createAdminPasskeys(f.options).list(),[saved]);
    assert.equal(fs.existsSync(path.join(f.dir,'.admin-passkeys.json')),true);
    assert.equal(fs.existsSync(path.join(f.dir,'disk-auth.json')),false);
    const flow=await f.auth.authenticationOptions({origin,binding});
    assert.deepEqual(flow.options.allowCredentials.map(item=>item.id),[key.id]);
    const response=key.login(flow,1,origin),result=await f.auth.authenticate({origin,binding,flowId:flow.flow_id,response});
    assert.equal(result.id,key.id);assert.ok(result.lastUsedAt);
    await assert.rejects(f.auth.authenticate({origin,binding,flowId:flow.flow_id,response}),/ADMIN_PASSKEY_FLOW_INVALID/);
    const replay=await f.auth.authenticationOptions({origin,binding});
    await assert.rejects(f.auth.authenticate({origin,binding,flowId:replay.flow_id,response:key.login(replay,1,origin)}),/ADMIN_PASSKEY_AUTHENTICATION_FAILED/);
});
test('admin flow rejects another browser/session, wrong origin, expiry and an invalidated TOTP setup',async t=>{
    const f=fixture(t),key=authenticator('admin.test');
    let flow=await f.auth.registrationOptions({origin,sessionId});
    await assert.rejects(f.auth.register({origin,sessionId:'different-session-with-no-authorization',flowId:flow.flow_id,response:key.register(flow,origin)}),/ADMIN_PASSKEY_FLOW_INVALID/);
    flow=await f.auth.registrationOptions({origin,sessionId});
    await assert.rejects(f.auth.register({origin:'https://evil.test',sessionId,flowId:flow.flow_id,response:key.register(flow,origin)}),/ADMIN_PASSKEY_FLOW_INVALID/);
    flow=await f.auth.registrationOptions({origin,sessionId});f.advance(300001);
    await assert.rejects(f.auth.register({origin,sessionId,flowId:flow.flow_id,response:key.register(flow,origin)}),/ADMIN_PASSKEY_FLOW_INVALID/);
    await register(f,key);flow=await f.auth.authenticationOptions({origin,binding});
    f.marker('new-totp-setup-invalidates-old-admin-key');
    assert.deepEqual(f.auth.list(),[]);
    await assert.rejects(f.auth.authenticate({origin,binding,flowId:flow.flow_id,response:key.login(flow,1,origin)}),/ADMIN_PASSKEY_FLOW_INVALID/);
});
test('a front-end credential cannot authenticate an admin even at the same RP, and tampered signatures fail',async t=>{
    const f=fixture(t),{key}=await register(f),frontEndKey=authenticator('admin.test');
    let flow=await f.auth.authenticationOptions({origin,binding});
    await assert.rejects(f.auth.authenticate({origin,binding,flowId:flow.flow_id,response:frontEndKey.login(flow,1,origin)}),/ADMIN_PASSKEY_AUTHENTICATION_FAILED/);
    flow=await f.auth.authenticationOptions({origin,binding});
    const response=key.login(flow,1,origin);response.response.signature=Buffer.alloc(64).toString('base64url');
    await assert.rejects(f.auth.authenticate({origin,binding,flowId:flow.flow_id,response}),/ADMIN_PASSKEY_AUTHENTICATION_FAILED/);
    assert.equal(f.auth.list()[0].lastUsedAt,0);
    await assert.rejects(f.auth.registrationOptions({origin:'http://public.test',sessionId}),/ADMIN_PASSKEY_ORIGIN_INVALID/);
    await assert.rejects(f.auth.registrationOptions({origin,sessionId,remark:'bad\nremark'}),/ADMIN_PASSKEY_REMARK_INVALID/);
});

test('a session revoked during asynchronous registration cannot save a new administrator credential',async t=>{
    const f=fixture(t),methods=await import('@simplewebauthn/server');let valid=true;
    const auth=createAdminPasskeys({...f.options,isSessionCurrent:()=>valid,webauthn:async()=>({...methods,
        verifyRegistrationResponse:async options=>{const result=await methods.verifyRegistrationResponse(options);valid=false;return result;}})});
    const key=authenticator('admin.test'),flow=await auth.registrationOptions({origin,sessionId});
    await assert.rejects(auth.register({origin,sessionId,flowId:flow.flow_id,response:key.register(flow,origin)}),/ADMIN_PASSKEY_SESSION_INVALID/);
    assert.deepEqual(auth.list(),[]);
});
