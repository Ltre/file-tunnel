'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),{io}=require('socket.io-client');
const cookie=(res,prefix)=>res.headers.getSetCookie().find(value=>value.startsWith(prefix+'='))?.split(';')[0]||'';
const json=(url,data,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data),redirect:'manual'});
const b64=data=>Buffer.from(JSON.stringify(data)).toString('base64url');
function totp(secret){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',bytes=[],bits=[];for(const char of secret)for(let i=4;i>=0;i--)bits.push((alphabet.indexOf(char)>>i)&1);
    for(let i=0;i+7<bits.length;i+=8)bytes.push(bits.slice(i,i+8).reduce((n,b)=>n*2+b,0));
    const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
    const h=crypto.createHmac('sha1',Buffer.from(bytes)).update(counter).digest(),offset=h[19]&15;
    return String((h.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
function proof(pair,jti,audience){const header={typ:'dbsc+jwt',alg:'ES256'};
    const claims={jti,aud:audience,iat:Math.floor(Date.now()/1000),key:pair.publicKey.export({format:'jwk'})};
    const signed=b64(header)+'.'+b64(claims);return signed+'.'+crypto.sign('sha256',Buffer.from(signed),{key:pair.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');}
test('trusted account publishes SHA-only Web ZIP; tamper, cross-record use and subsequent permission revocation fail closed',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-trusted-e2e-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const secret='JBSWY3DPEHPK3PXP';fs.writeFileSync(path.join(dir,'.gauth-admin.json'),JSON.stringify({secret,createdAt:'test-marker'}));
    const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
    let logs='';const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port),TUNNEL_DATA_DIR:dir,TELEGRAM_OIDC_MOCK_ENABLED:'1'},stdio:['ignore','pipe','pipe']});
    t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});for(const stream of [child.stdout,child.stderr])stream.on('data',value=>logs=(logs+value).slice(-2000));
    const root='http://127.0.0.1:'+port;let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null)break;try{if((await fetch(root+'/api/admin/auth/status')).ok){ready=true;break;}}catch(_){}await new Promise(resolve=>setTimeout(resolve,40));}
    assert.ok(ready,logs);

    const login=await json(root+'/api/admin/auth/login',{token:totp(secret)});assert.equal(login.status,200);
    const pending=cookie(login,'__Host-tunnel_admin_dbsc_pending'),challenge=/challenge="([^"]+)"/.exec(login.headers.get('Secure-Session-Registration'))?.[1];
    assert.ok(pending&&challenge);
    const pair=crypto.generateKeyPairSync('ec',{namedCurve:'P-256'});
    const bound=await json(root+'/api/admin/auth/dbsc/register',{}, {Cookie:pending,
        'Secure-Session-Response':proof(pair,challenge,root+'/api/admin/auth/dbsc/register')});
    assert.equal(bound.status,200);const adminCookie=cookie(bound,'__Host-tunnel_admin_session');assert.ok(adminCookie);

    const start=await fetch(root+'/api/telegram/drive/oidc/start',{redirect:'manual'});assert.equal(start.status,302);
    const stateCookie=cookie(start,'tunnel_telegram_oidc_state')||start.headers.getSetCookie().find(value=>value.includes('oidc')&&value.includes('state='))?.split(';')[0];
    const state=new URL(start.headers.get('location'),root).searchParams.get('state');assert.ok(state&&stateCookie);
    const callback=await fetch(`${root}/api/telegram/drive/oidc/callback?state=${encodeURIComponent(state)}&mock_user_id=999000333`,{headers:{cookie:stateCookie},redirect:'manual'});
    assert.equal(callback.status,200);
    const diskCookie=cookie(callback,'drop2tunnel_telegram_drive');assert.ok(diskCookie);
    const me=await (await fetch(root+'/api/telegram/drive/me',{headers:{cookie:diskCookie}})).json();assert.ok(me.identity?.id);
    const permissions=await fetch(`${root}/api/telegram/disk-admin/users/${encodeURIComponent(me.identity.id)}/permissions`,{method:'PATCH',
        headers:{Cookie:adminCookie,'Content-Type':'application/json'},body:JSON.stringify({permissions:{'webZip.publishEdit':true}})});
    assert.equal(permissions.status,200);

    const socket=io(root,{transports:['websocket'],reconnection:false});t.after(()=>socket.close());
    await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
    const grantPromise=new Promise(resolve=>socket.once('tunnel-access-grant',resolve));
    const sessionId=crypto.randomUUID(),deviceId=crypto.randomUUID(),messageId=crypto.randomUUID(),fileId=crypto.randomUUID();
    socket.emit('join-session',{sessionId,deviceId,deviceName:'Trusted device',createTunnel:true});
    const grant=(await grantPromise).grant;await new Promise(resolve=>setTimeout(resolve,80));
    // Reconciliation is also a write path. An unauthenticated socket may not
    // smuggle an unsigned executable archive through its restored history.
    const unsignedId=crypto.randomUUID();
    const reconciliation=new Promise(resolve=>socket.once('session-history',resolve));
    socket.emit('history-reconcile',{sessionId,messages:[{id:unsignedId,sender:deviceId,type:'file',timestamp:Date.now(),
        fileInfo:{id:crypto.randomUUID(),name:'restored.html.zip',type:'application/zip',webZip:true,size:4}}]});
    const recovered=await reconciliation;
    assert.equal(recovered.messages.some(message=>message.id===unsignedId),false,'unsigned web ZIP must not be restored into server history');
    const authorize=await json(root+'/api/telegram/web-zip/socket-auth',{sessionId,deviceId,socketId:socket.id,accessGrant:grant},{Cookie:diskCookie});
    assert.equal(authorize.status,200);const body=await authorize.json();
    const emit=(event,data)=>new Promise((resolve,reject)=>socket.timeout(5000).emit(event,data,(error,value)=>error?reject(error):resolve(value)));
    assert.equal((await emit('web-zip-auth',{proof:body.proof})).ok,true);
    const sha256=crypto.createHash('sha256').update('original ZIP bytes fixture').digest('hex');
    const restoredMessageId=crypto.randomUUID(),restoredFileId=crypto.randomUUID(),forgedMessageId=crypto.randomUUID();
    const restoredStamp=await emit('web-zip-stamp',{sessionId,messageId:restoredMessageId,fileId:restoredFileId,sha256});
    assert.equal(restoredStamp.ok,true);
    const restoredFile={id:restoredFileId,name:'restored.html.zip',type:'application/zip',webZip:true,size:26,
        webZipSha256:sha256,webZipTrustIntegrityStamp:restoredStamp.stamp};
    const signedReconciliation=new Promise(resolve=>socket.once('session-history',resolve));
    socket.emit('history-reconcile',{sessionId,messages:[
        {id:restoredMessageId,sender:deviceId,type:'file',timestamp:Date.now(),fileInfo:restoredFile},
        {id:forgedMessageId,sender:deviceId,type:'file',timestamp:Date.now(),fileInfo:restoredFile}
    ]});
    const signedSnapshot=await signedReconciliation;
    assert.equal(signedSnapshot.messages.some(message=>message.id===restoredMessageId),true,'signed same-record restore must still work');
    assert.equal(signedSnapshot.messages.some(message=>message.id===forgedMessageId),false,'a stamp cannot be moved to another restored record');
    const stamped=await emit('web-zip-stamp',{sessionId,messageId,fileId,sha256});assert.equal(stamped.ok,true);
    const recorded=new Promise(resolve=>socket.once('message-ack',resolve));
    socket.emit('message',{sessionId,message:{id:messageId,sender:deviceId,type:'file',timestamp:Date.now(),
        fileInfo:{id:fileId,name:'trusted.html.zip',type:'application/zip',size:26,webZip:true,webZipSha256:sha256,webZipTrustIntegrityStamp:stamped.stamp}}});
    assert.equal((await recorded).stored,true);
    const verifyPayload={fileId,messageId,sessionId,sha256,stamp:stamped.stamp};
    assert.equal((await json(root+'/api/telegram/web-zip/verify',verifyPayload)).status,200);
    for(const changed of [{sha256:'0'.repeat(64)},{messageId:crypto.randomUUID()},{sessionId:crypto.randomUUID()},{stamp:stamped.stamp+'x'}])
        assert.equal((await json(root+'/api/telegram/web-zip/verify',{...verifyPayload,...changed})).status,403);
    const revoke=await fetch(`${root}/api/telegram/disk-admin/users/${encodeURIComponent(me.identity.id)}/permissions`,{method:'PATCH',
        headers:{Cookie:adminCookie,'Content-Type':'application/json'},body:JSON.stringify({permissions:{'webZip.publishEdit':false}})});
    assert.equal(revoke.status,200);
    assert.equal((await json(root+'/api/telegram/web-zip/verify',verifyPayload)).status,403);
    assert.equal((await emit('web-zip-stamp',{sessionId,messageId:crypto.randomUUID(),fileId:crypto.randomUUID(),sha256})).ok,false);
});
