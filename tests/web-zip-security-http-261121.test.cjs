'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),{io}=require('socket.io-client');

test('running server denies anonymous Web ZIP publication, forged trust verification and unbound admin security APIs',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-security-http-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;
    await new Promise(resolve=>probe.close(resolve));
    const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),
        env:{...process.env,PORT:String(port),TUNNEL_DATA_DIR:dir,TELEGRAM_OIDC_MOCK_ENABLED:'1'},stdio:['ignore','pipe','pipe']});
    t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
    let output='';child.stdout.on('data',value=>output=(output+value).slice(-1200));child.stderr.on('data',value=>output=(output+value).slice(-1200));
    const root='http://127.0.0.1:'+port;
    let ready=false;
    for(let attempt=0;attempt<120;attempt++){
        if(child.exitCode!==null)break;
        try{if((await fetch(root+'/api/admin/auth/status')).ok){ready=true;break;}}catch(_){}
        await new Promise(resolve=>setTimeout(resolve,40));
    }
    assert.ok(ready,output||'HTTP server failed to start');
    const post=(url,body)=>fetch(root+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const access=await fetch(root+'/api/telegram/web-zip/access');
    assert.equal(access.status,200);assert.equal((await access.json()).allowed,false);
    assert.equal((await post('/api/telegram/web-zip/socket-auth',{sessionId:'forged',deviceId:'forged',socketId:'forged'})).status,403);
    assert.equal((await post('/api/telegram/web-zip/verify',{preview:true,fileId:'file',messageId:'message',sessionId:'session',sha256:'0'.repeat(64),stamp:'wzt1.forged.forged'})).status,403);
    const security=await fetch(root+'/api/admin/security/sessions');assert.equal(security.status,401);
    assert.equal((await fetch(root+'/api/telegram/disk-admin/users')).status,401);
    const admin=await fetch(root+'/admin/security',{redirect:'manual'});assert.equal(admin.status,302);
    assert.equal((await fetch(root+'/api/admin/auth/status')).status,200);
    const socket=io(root,{transports:['websocket'],reconnection:false});t.after(()=>socket.close());
    await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
    const joined=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('join timeout')),3000);socket.once('tunnel-access-grant',data=>{clearTimeout(timer);resolve(data);});});
    const sessionId=crypto.randomUUID(),deviceId=crypto.randomUUID(),fileId=crypto.randomUUID(),messageId=crypto.randomUUID();
    socket.emit('join-session',{sessionId,deviceId,deviceName:'Untrusted test',createTunnel:true});
    await joined;
    await new Promise(resolve=>setTimeout(resolve,80));
    const emit=(name,data)=>new Promise((resolve,reject)=>socket.timeout(4000).emit(name,data,(error,result)=>error?reject(error):resolve(result)));
    assert.equal((await emit('web-zip-auth',{proof:'forged'})).ok,false);
    assert.equal((await emit('web-zip-stamp',{sessionId,fileId,messageId,sha256:'0'.repeat(64)})).ok,false);
    const denied=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('unsigned Web ZIP was not rejected: '+output)),3000);
        socket.once('permission-denied',value=>{clearTimeout(timer);resolve(value);});
        socket.once('message-ack',value=>{clearTimeout(timer);reject(Error('unsigned Web ZIP was acknowledged: '+JSON.stringify(value)));});});
    socket.emit('message',{sessionId,message:{id:messageId,type:'file',sender:deviceId,fileInfo:{id:fileId,name:'malicious.html.zip',size:0,type:'application/zip',webZip:true},timestamp:Date.now()}});
    assert.ok((await denied).capability);
});
