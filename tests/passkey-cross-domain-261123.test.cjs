'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const express=require('express'),{createDiskAuth}=require('../server/disk-auth'),{createDiskAPI}=require('../server/disk-api');
const {createDiskAccountSessions}=require('../server/disk-account-sessions'),{createDiskOperations}=require('../server/disk-operations'),{createTelegramDriveStore}=require('../server/telegram-drive');
const {openDiskRepository}=require('../server/disk-repository'),authenticator=require('./support/passkey-authenticator.cjs');
const {listenHttp}=require('./support/listen-http.cjs');
function fixture(t){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'passkey-261123-'));let time=Date.now(),origins=['https://a.test','https://b.test','https://c.test'];
    const auth=createDiskAuth({dataDir:dir,now:()=>time,trustedOrigins:()=>origins});
    t.after(()=>{openDiskRepository(dir).close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('passkey-261123-'));fs.rmSync(dir,{recursive:true,force:true});});
    return {auth,dir,advance:ms=>time+=ms,setOrigins:value=>origins=value};
}
async function register(auth,key,{username='alice',origin='https://b.test',existingUserId=''}={}){
    const flow=await auth.passkeyOptions({kind:'register',username,origin,binding:'browser',existingUserId});
    return auth.passkeyVerify({flowId:flow.flow_id,binding:'browser',existingUserId,origin,response:key.register(flow,origin)});
}
test('真实签名：多域名共享一个用户，同 RP 多凭据，ROR 验证原 RP 和实际 Origin，备注不参与认证',async t=>{
    const {auth,advance}=fixture(t),b=authenticator('b.test'),a=authenticator('a.test'),second=authenticator('a.test');
    const user=await register(auth,b);
    assert.deepEqual(auth.passkeyChoices({username:'alice',origin:'https://a.test'}).rpIDs,['b.test']);
    const existing=await auth.passkeyOptions({kind:'register',username:'alice',origin:'https://a.test',binding:'new',allowExisting:true});
    assert.equal(existing.loginRequired,true);assert.equal(existing.options,undefined);assert.equal(auth.users().length,1);
    const ror=await auth.passkeyOptions({kind:'login',username:'alice',rpID:'b.test',origin:'https://a.test',binding:'browser'});
    const authenticated=await auth.passkeyVerify({flowId:ror.flow_id,binding:'browser',origin:'https://a.test',response:b.login(ror,1,'https://a.test')});
    assert.equal(authenticated.id,user.id);assert.equal(authenticated.authenticatedRpID,'b.test');
    await register(auth,a,{origin:'https://a.test',existingUserId:user.id});await register(auth,second,{origin:'https://a.test',existingUserId:user.id});
    assert.equal(auth.users().length,1);assert.equal(auth.passkeys(user.id).length,3);
    assert.deepEqual(auth.passkeyChoices({username:'alice',origin:'https://a.test'}).rpIDs,['a.test','b.test']);
    for(const key of [a,second]){
        auth.renamePasskey(user.id,key.id,'同一备注');advance(1000);
        const flow=await auth.passkeyOptions({kind:'login',username:'alice',origin:'https://a.test',binding:'browser'});
        assert.equal(flow.options.allowCredentials.length,2);
        const result=await auth.passkeyVerify({flowId:flow.flow_id,binding:'browser',response:key.login(flow)});assert.equal(result.id,user.id);
        assert.ok(auth.passkeys(user.id).find(item=>item.id===key.id).lastUsedAt>0);
    }
    assert.equal(auth.passkeys(user.id).filter(item=>item.remark==='同一备注').length,2);
    assert.ok(auth.passkeys(user.id).every(key=>key.publicKey===undefined&&key.counter===undefined));
});
test('ROR 拒绝未授权 Origin、错误 RP、签名、UV、过期和重放；域名停用不使其他独立凭据失效',async t=>{
    const {auth,setOrigins,advance}=fixture(t),b=authenticator('b.test'),a=authenticator('a.test');const user=await register(auth,b);await register(auth,a,{origin:'https://a.test',existingUserId:user.id});
    await assert.rejects(auth.passkeyOptions({kind:'login',username:'alice',rpID:'b.test',origin:'https://evil.test',binding:'browser'}));
    for(const wrong of ['origin','rp','signature','uv','expiry']){
        const flow=await auth.passkeyOptions({kind:'login',username:'alice',rpID:'b.test',origin:'https://a.test',binding:'browser'});
        const response=wrong==='rp'?a.login(flow,1,'https://a.test'):b.login(flow,1,wrong==='origin'?'https://evil.test':'https://a.test');
        if(wrong==='signature')response.response.signature=Buffer.alloc(64).toString('base64url');
        if(wrong==='uv'){const bytes=Buffer.from(response.response.authenticatorData,'base64url');bytes[32]=1;response.response.authenticatorData=bytes.toString('base64url');}
        if(wrong==='expiry')advance(300001);
        await assert.rejects(auth.passkeyVerify({flowId:flow.flow_id,binding:'browser',response}));
        await assert.rejects(auth.passkeyVerify({flowId:flow.flow_id,binding:'browser',response}));
    }
    setOrigins(['https://a.test','https://c.test']);
    const flow=await auth.passkeyOptions({kind:'login',username:'alice',origin:'https://a.test',binding:'browser'});
    assert.equal((await auth.passkeyVerify({flowId:flow.flow_id,binding:'browser',response:a.login(flow)})).id,user.id);
    assert.equal(auth.passkeys(user.id).find(item=>item.id===b.id).rpID,'b.test','旧凭据不被伪迁移或删除');
});
test('短期跨域交接：真实签名后绑定目标浏览器，只用一次，拒绝改账号、目标、凭证、过期与退役域名',async t=>{
    const {auth,advance,setOrigins}=fixture(t),b=authenticator('b.test');const user=await register(auth,b);let counter=0;
    async function ready(){const begin=auth.startHandoff({username:'alice',rpID:'b.test',origin:'https://a.test',binding:'target-browser',returnPath:'/account-center?disk_account='+user.id});
        const attempt=await auth.handoffOptions({id:begin.flow_id,origin:'https://b.test',binding:'source-browser'});
        const result=await auth.handoffVerify({flowId:attempt.flow_id,binding:'source-browser',origin:'https://b.test',response:b.login(attempt,++counter)});
        const values=new URLSearchParams(new URL(result.url).hash.slice(1));return {id:values.get('complete'),code:values.get('code')};}
    const readyFlow=await ready();
    for(const [binding,origin,code] of [['wrong-browser','https://a.test',readyFlow.code],['target-browser','https://c.test',readyFlow.code],['target-browser','https://a.test','tampered']])assert.throws(()=>auth.completeHandoff({...readyFlow,binding,origin,code}),/FLOW_INVALID/);
    const result=auth.completeHandoff({...readyFlow,binding:'target-browser',origin:'https://a.test'});assert.equal(result.identity.id,user.id);assert.match(result.returnPath,/^\/account-center/);assert.equal(auth.users().length,1);
    assert.throws(()=>auth.completeHandoff({...readyFlow,binding:'target-browser',origin:'https://a.test'}),/FLOW_INVALID/);
    const expired=await ready();advance(300001);assert.throws(()=>auth.completeHandoff({...expired,binding:'target-browser',origin:'https://a.test'}),/FLOW_INVALID/);
    const cancelled=await ready();auth.cancelHandoff({id:cancelled.id,binding:'target-browser',origin:'https://a.test'});assert.throws(()=>auth.completeHandoff({...cancelled,binding:'target-browser',origin:'https://a.test'}),/FLOW_INVALID/);
    const retired=await ready();setOrigins(['https://a.test']);assert.throws(()=>auth.completeHandoff({...retired,binding:'target-browser',origin:'https://a.test'}),/FLOW_INVALID/);
    assert.throws(()=>auth.startHandoff({username:'alice',rpID:'b.test',origin:'https://a.test',binding:'browser',returnPath:'https://evil.test'}));
});
test('HTTP 集成：S3 停用不删除分区，原删除确认仍有效；Passkey 管理按当前账号隔离并要求近期认证',async t=>{
    const {auth,dir,advance}=fixture(t),key=authenticator('b.test'),user=await register(auth,key),other=auth.fromTelegram({id:'1922117'});
    auth.setPermissions(user.id,{'disk.s3.manage':true});
    const sessions=createDiskAccountSessions({keyForRequest:()=>auth.sessionKey,user:id=>auth.user(id)}),store=createTelegramDriveStore({dataDir:dir}),operations=createDiskOperations({dataDir:dir});
    const origin=()=> 'https://b.test';let changed=0;
    const api=createDiskAPI({dataDir:dir,auth,defaultStore:store,operations,telegram:{},getDefaultBackend:()=>({}),getIdentity:req=>sessions.identity(req),setIdentity:(req,res,value)=>sessions.set(req,res,value),getOrigin:origin,isMockRequest:()=>false,maxDepth:()=>30,onPermissionsChanged:()=>changed++});
    const app=express();app.use(express.json());app.post('/fixture/login/:id',(req,res)=>{sessions.set(req,res,auth.user(req.params.id));res.json({});});app.use('/drive',api.browser);app.use('/admin',api.admin);
    const server=await listenHttp(app),base='http://127.0.0.1:'+server.address().port;let cookie='';
    t.after(async()=>{api.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
    async function call(route,body,{method=body?'POST':'GET',headers={},account=user.id}={}){const response=await fetch(base+route,{method,headers:{Cookie:cookie,'X-Disk-Account':account,Origin:'https://b.test',...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});const next=response.headers.getSetCookie();if(next.length)cookie=next.map(value=>value.split(';')[0]).join('; ');return {status:response.status,data:await response.json()};}
    await call('/fixture/login/'+user.id,{});
    const settings=await call('/admin/passkey-origins');assert.equal(settings.status,200);assert.equal(settings.data.dependencies[0].userId,user.id);
    assert.equal((await call('/admin/passkey-origins',{origins:['https://a.test','https://b.test'],revision:settings.data.revision},{method:'PUT',headers:{Origin:'https://evil.test'}})).status,403);
    const configured=await call('/admin/passkey-origins',{origins:['https://a.test','https://b.test'],revision:settings.data.revision},{method:'PUT'});assert.equal(configured.status,200);
    assert.equal((await call('/admin/passkey-origins',{origins:[],revision:settings.data.revision},{method:'PUT'})).status,409);
    const enabled=await call('/drive/spaces/s3',{});assert.equal(enabled.status,201);assert.equal(enabled.data.credential.enabled,true);
    const disabled=await call('/drive/spaces/s3',null,{method:'DELETE'});assert.equal(disabled.status,200);assert.equal(disabled.data.credential.enabled,false);assert.notEqual(disabled.data.error,'DISK_SPACE_DELETE_CONFIRM_REQUIRED');
    assert.equal((await call('/drive/spaces/not-a-partition',null,{method:'DELETE'})).data.error,'DISK_SPACE_DELETE_CONFIRM_REQUIRED');
    assert.equal((await call('/drive/spaces')).data.spaces.length,1);
    const before=await call('/drive/passkeys/'+encodeURIComponent(key.id),{remark:'主力'},{method:'PATCH'});assert.equal(before.data.error,'PASSKEY_REAUTH_REQUIRED');
    const req={headers:{cookie,'x-disk-account':user.id}};sessions.identity(req);auth.rememberAuthentication(user.id,req.diskSessionCookie,'https://b.test');
    assert.equal((await call('/drive/passkeys/'+key.id,{remark:'主力'},{method:'PATCH'})).status,200);
    await call('/fixture/login/'+other.id,{});assert.equal((await call('/drive/passkeys/'+key.id,{remark:'劫持'},{method:'PATCH',account:other.id})).data.error,'PASSKEY_REAUTH_REQUIRED');
    advance(300001);assert.equal((await call('/drive/passkeys/register/options',{username:'alice',addAccount:false},{account:other.id})).data.error,'PASSKEY_REAUTH_REQUIRED');
    assert.equal((await call('/admin/users/'+user.id+'/passkeys/'+key.id,null,{method:'DELETE',headers:{Origin:'https://evil.test'}})).status,403);
    assert.equal((await call('/admin/users/'+user.id+'/passkeys/'+key.id,null,{method:'DELETE'})).data.error,'PASSKEY_LAST_CREDENTIAL');
    const backup=authenticator('b.test');await register(auth,backup,{existingUserId:user.id});
    assert.equal((await call('/admin/users/'+user.id+'/passkeys/'+backup.id,null,{method:'DELETE'})).status,200);assert.equal(auth.passkeys(user.id).length,1);assert.equal(auth.passkeys(user.id)[0].id,key.id);
    const update=await call('/admin/users/'+user.id+'/permissions',{permissions:{'webZip.publishEdit':true}},{method:'PATCH'});assert.equal(update.status,200);assert.equal(changed,1);
});

test('已有凭据不推断历史使用时间，旧数据仍能验证，新建失败不留下半成品账号',async t=>{
    const f=fixture(t),key=authenticator('b.test'),user=await register(f.auth,key),repository=openDiskRepository(f.dir);
    const users=repository.load('users');delete users[0].passkeys[0].lastUsedAt;delete users[0].passkeys[0].remark;repository.replace('users',users,item=>item.id);
    const auth=createDiskAuth({dataDir:f.dir,trustedOrigins:()=>['https://a.test','https://b.test']});
    assert.equal(auth.passkeys(user.id)[0].lastUsedAt,null);assert.equal(auth.passkeys(user.id)[0].remark,'');
    const flow=await auth.passkeyOptions({kind:'login',username:'alice',origin:'https://b.test',binding:'browser'});assert.equal((await auth.passkeyVerify({flowId:flow.flow_id,binding:'browser',response:key.login(flow)})).id,user.id);
    assert.ok(auth.passkeys(user.id)[0].lastUsedAt>0);
    const failed=await auth.passkeyOptions({kind:'register',username:'incomplete',origin:'https://a.test',binding:'browser'});
    await assert.rejects(auth.passkeyVerify({flowId:failed.flow_id,binding:'browser',response:key.register(failed,'https://b.test')}));assert.equal(auth.users().length,1);
});

test('后台域名配置持久保存并热生效，允许清空，校验 HTTPS 与冲突，不改已有凭据',async t=>{
    const f=fixture(t),key=authenticator('b.test'),user=await register(f.auth,key),initial=f.auth.passkeyOriginSettings();
    const saved=f.auth.savePasskeyOriginSettings({origins:['https://a.test','https://b.test','https://b.test'],revision:initial.revision});
    assert.deepEqual(saved.origins,['https://a.test','https://b.test']);assert.equal(saved.source,'saved');
    const reopened=createDiskAuth({dataDir:f.dir,trustedOrigins:()=>['https://ignored.test']});assert.deepEqual(reopened.passkeyOrigins(),saved.origins);
    for(const bad of ['http://a.test','https://*.test','https://a.test/path','https://user:password@a.test'])assert.throws(()=>f.auth.savePasskeyOriginSettings({origins:[bad],revision:saved.revision}),/ORIGIN_INVALID/);
    assert.throws(()=>f.auth.savePasskeyOriginSettings({origins:[],revision:initial.revision}),/CONFLICT/);
    const cleared=f.auth.savePasskeyOriginSettings({origins:[],revision:saved.revision});assert.deepEqual(cleared.origins,[]);assert.deepEqual(f.auth.passkeyChoices({username:'alice',origin:'https://a.test'}).rpIDs,[]);
    assert.equal(f.auth.passkeys(user.id)[0].rpID,'b.test');assert.equal(reopened.user(user.id).id,user.id);
});
