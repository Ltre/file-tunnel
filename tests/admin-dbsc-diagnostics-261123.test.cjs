'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAdminAuth}=require('../server/admin-auth');
const request=(headers={})=>({headers,protocol:'https',get(name){return headers[name.toLowerCase()]||'';},ip:'127.0.0.1'});
const response=()=>({headers:{},setHeader(name,value){this.headers[name]=value;}});
const start=(auth)=>{
    const res=response();auth.beginBinding(request({host:'example.com'}),res);
    return {cookie:res.headers['Set-Cookie'].find(value=>value.startsWith('__Host-tunnel_admin_dbsc_pending=')).split(';')[0],
        challenge:/challenge="([^"]+)"/.exec(res.headers['Secure-Session-Registration'])[1]};
};
const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');

test('DBSC progress belongs only to its TOTP pending cookie and never grants authentication',t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-dbsc-diag-261123-'));
    t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('admin-dbsc-diag-261123-'));fs.rmSync(dir,{recursive:true,force:true});});
    fs.writeFileSync(path.join(dir,'.gauth-admin.json'),JSON.stringify({secret:'JBSWY3DPEHPK3PXP',createdAt:'fixture'}));
    const auth=createAdminAuth({dataDir:dir}),first=start(auth),second=start(auth);
    const pendingReq=request({host:'example.com',cookie:first.cookie});
    assert.equal(auth.bindingStatus(request()),null);
    assert.equal(auth.bindingStatus(request({cookie:'__Host-tunnel_admin_dbsc_pending=unknown'})),null);
    const status=auth.bindingStatus(pendingReq);
    assert.deepEqual(Object.keys(status).sort(),['expiresAt','state']);
    assert.equal(status.state,'awaiting-registration');
    assert.equal(auth.isAuthenticated(pendingReq),false);
    assert.equal(auth.registerDbsc(pendingReq,response()),null);
    assert.equal(auth.bindingStatus(pendingReq).state,'registration-rejected');
    assert.equal(auth.bindingStatus(request({cookie:second.cookie})).state,'awaiting-registration');
    assert.equal(auth.sessions().length,0);
    const pair=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'});
    const body=b64({typ:'dbsc+jwt',alg:'ES256'})+'.'+b64({jti:first.challenge,
        aud:'https://example.com/api/admin/auth/dbsc/register',iat:Math.floor(Date.now()/1000),key:pair.publicKey.export({format:'jwk'})});
    const proof=body+'.'+crypto.sign('sha256',Buffer.from(body),{key:pair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
    const reg=response();assert.ok(auth.registerDbsc(request({host:'example.com',cookie:first.cookie,'secure-session-response':proof}),reg));
    assert.equal(auth.bindingStatus(pendingReq),null);
    assert.equal(auth.sessions().length,1);
    assert.equal(auth.sessions()[0].dbscBound,true);
    const grant=reg.headers['Set-Cookie'].find(value=>value.startsWith('__Host-tunnel_admin_session=')).split(';')[0];
    assert.equal(auth.isAuthenticated(request({cookie:grant})),true);
});

test('expired pending registration is distinguishable without exposing challenge or proof',t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-dbsc-expiry-261123-'));
    t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('admin-dbsc-expiry-261123-'));fs.rmSync(dir,{recursive:true,force:true});});
    const auth=createAdminAuth({dataDir:dir}),pending=start(auth),req=request({cookie:pending.cookie});
    const originalNow=Date.now;
    try{
        const later=originalNow()+121000;Date.now=()=>later;
        assert.equal(auth.bindingStatus(req).state,'expired');
        assert.equal(auth.registerDbsc(req,response()),null);
        assert.equal(auth.isAuthenticated(req),false);
    }finally{Date.now=originalNow;}
});

test('actual server HTTP status reports only the requesting browser pending registration', {timeout:30000},async t=>{
    const {spawn}=require('node:child_process'),net=require('node:net');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-dbsc-http-261123-'));let child;
    t.after(async()=>{
        if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}
        assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('admin-dbsc-http-261123-'));
        fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
    });
    const secret='JBSWY3DPEHPK3PXP';fs.writeFileSync(path.join(dir,'.gauth-admin.json'),JSON.stringify({secret,createdAt:'fixture'}));
    const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(crypto.randomInt(20000,60000),'127.0.0.1',resolve);});const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
    child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),TUNNEL_DATA_DIR:dir,TELEGRAM_OIDC_MOCK_ENABLED:'1'},stdio:['ignore','pipe','pipe']});
    let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',value=>logs=(logs+value).slice(-2000));
    const root='http://127.0.0.1:'+port,status=headers=>fetch(root+'/api/admin/auth/status',{headers}).then(res=>res.json());
    let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null)break;try{if((await status()).configured){ready=true;break;}}catch(_){}await new Promise(resolve=>setTimeout(resolve,40));}
    assert.ok(ready,logs);assert.equal((await status()).bindingStatus,null);
    const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
    const digest=crypto.createHmac('sha1',Buffer.from('48656c6c6f21deadbeef','hex')).update(counter).digest(),offset=digest[19]&15;
    const token=String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
    const post=(route,data,headers={})=>fetch(root+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
    const login=await post('/api/admin/auth/login',{token},{'X-Forwarded-Proto':'https'});assert.equal(login.status,200);
    const pending=login.headers.getSetCookie().find(value=>value.startsWith('__Host-tunnel_admin_dbsc_pending=')).split(';')[0];
    const pendingStatus=await status({Cookie:pending});assert.equal(pendingStatus.authenticated,false);
    assert.equal(pendingStatus.bindingStatus.state,'awaiting-registration');
    assert.deepEqual(Object.keys(pendingStatus.bindingStatus).sort(),['expiresAt','state']);
    assert.equal((await status()).bindingStatus,null,'another browser must not see this pending state');
    const denied=await post('/api/admin/auth/dbsc/register',{}, {Cookie:pending});assert.equal(denied.status,403);
    assert.equal((await status({Cookie:pending})).bindingStatus.state,'registration-rejected');
    assert.equal((await status({Cookie:pending})).authenticated,false);
    const pair=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'}),challenge=/challenge="([^"]+)"/.exec(login.headers.get('Secure-Session-Registration'))[1];
    const data=b64({typ:'dbsc+jwt',alg:'ES256'})+'.'+b64({jti:challenge,aud:root+'/api/admin/auth/dbsc/register',iat:Math.floor(Date.now()/1000),key:pair.publicKey.export({format:'jwk'})});
    const signed=data+'.'+crypto.sign('sha256',Buffer.from(data),{key:pair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
    const registered=await post('/api/admin/auth/dbsc/register',{}, {Cookie:pending,'Secure-Session-Response':signed});assert.equal(registered.status,200);
    const granted=registered.headers.getSetCookie().find(value=>value.startsWith('__Host-tunnel_admin_session=')).split(';')[0];
    const confirmed=await status({Cookie:granted});assert.equal(confirmed.authenticated,true);assert.equal(confirmed.bindingStatus,null);
});
