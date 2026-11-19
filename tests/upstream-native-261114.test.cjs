'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),net=require('node:net'),tls=require('node:tls'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {createUpstreamExits}=require('../server/upstream-exits');
test('native sing-box carries HTTP through a real Trojan TLS server, verifies TLS per node and releases the last task', {timeout:25000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-trojan-bugb-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const openssl=process.platform==='win32'?'D:/InstalledApps/Git/usr/bin/openssl.exe':'openssl';
 execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem'),'-days','1','-subj','/CN=fixture.invalid'],{stdio:'ignore',windowsHide:true});
 const sockets=new Set();const track=s=>{sockets.add(s);s.on('error',()=>{});s.once('close',()=>sockets.delete(s));return s;};
 const target=http.createServer((_req,res)=>res.end(JSON.stringify({id:'fixture',formats:[{format_id:'18'}]})));target.on('connection',track);await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
 const password='synthetic-trojan-password';let connections=0;
 const proxy=tls.createServer({key:fs.readFileSync(path.join(dir,'key.pem')),cert:fs.readFileSync(path.join(dir,'cert.pem'))},socket=>{
  track(socket);let buffer=Buffer.alloc(0),done=false;
  function receive(chunk){buffer=Buffer.concat([buffer,chunk]);if(done||buffer.length<68)return;
   if(buffer.subarray(0,56).toString()!==crypto.createHash('sha224').update(password).digest('hex'))return socket.destroy();
   let host,port,offset;if(buffer[59]===1){host=[...buffer.subarray(60,64)].join('.');port=buffer.readUInt16BE(64);offset=68;}else if(buffer[59]===3){const len=buffer[60];if(buffer.length<65+len)return;host=buffer.subarray(61,61+len).toString();port=buffer.readUInt16BE(61+len);offset=65+len;}else return socket.destroy();
   assert.equal(host,'127.0.0.1');assert.equal(port,target.address().port);done=true;connections++;socket.pause();socket.removeListener('data',receive);
   const destination=track(net.connect(port,host));destination.once('connect',()=>{if(buffer.length>offset)destination.write(buffer.subarray(offset));socket.pipe(destination);destination.pipe(socket);socket.resume();});socket.on('close',()=>destination.destroy());destination.on('close',()=>socket.destroy());
  }socket.on('data',receive);
 });proxy.on('connection',track);proxy.on('tlsClientError',()=>{});await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const s of sockets)s.destroy();await Promise.all([new Promise(r=>target.close(r)),new Promise(r=>proxy.close(r))]);});
 const exits=createUpstreamExits({dataDir:dir,idleMs:60});t.after(()=>exits.close());
 const a=exits.saveNode(null,{name:'需要验证的测试证书',server:'127.0.0.1',port:proxy.address().port,password,serverName:'fixture.invalid',verifyTls:true});
 const b=exits.saveNode(null,{name:'允许自签名测试证书',server:'127.0.0.1',port:proxy.address().port,password,serverName:'fixture.invalid',verifyTls:false});
 exits.saveService('youtube',{revision:0,defaultExit:a.id,mode:'ordered',order:[b.id],includeDirect:false});
 assert.equal(exits.publicConfig().runtimes.length,0);
 await exits.runTask({url:'https://youtube.com/watch?v=fixture'},async()=>{
  const value=await exits.content('https://youtube.com/watch?v=fixture',async()=>{const response=await exits.fetch('http://127.0.0.1:'+target.address().port+'/',{signal:AbortSignal.timeout(6000)});return response.json();});
  assert.equal(value.id,'fixture');assert.equal(exits.current().selected.id,b.id);assert.deepEqual(exits.current().attempts.map(x=>x.status),['failed','success']);
 });assert.ok(connections>0);const checked=await exits.testPage('http://127.0.0.1:'+target.address().port+'/',b.id);assert.equal(checked.httpStatus,200);assert.equal(checked.exitName,b.name);await assert.rejects(exits.testPage('http://127.0.0.1:'+target.address().port+'/',a.id),/测试失败/);await new Promise(r=>setTimeout(r,180));assert.equal(exits.publicConfig().runtimes.length,0);
});
