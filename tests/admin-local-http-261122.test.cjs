'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createAdminAuth}=require('../server/admin-auth');
const request=(headers={},remote='127.0.0.1',protocol='http')=>({protocol,socket:{remoteAddress:remote},headers:{host:'localhost:80',...headers},get(name){return this.headers[name.toLowerCase()]||'';}});
const response=()=>({headers:{},setHeader(name,value){this.headers[name]=value;}});
const cookie=res=>[].concat(res.headers['Set-Cookie']).find(value=>value.startsWith('__Host-tunnel_admin_session='))?.split(';')[0];
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-local-http-261122-'));
 fs.writeFileSync(path.join(dir,'.gauth-admin.json'),JSON.stringify({secret:'JBSWY3DPEHPK3PXP',createdAt:'fixture'}));
 t.after(()=>{const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('admin-local-http-261122-'));fs.rmSync(target,{recursive:true,force:true});});
 return {auth:createAdminAuth({dataDir:dir}),dir};
}
test('local test eligibility requires the real loopback peer and exact HTTP host, without any forwarding signal',t=>{
 const {auth}=fixture(t);
 for(const remote of ['127.0.0.1','::1','::ffff:127.0.0.1'])assert.equal(auth.localHttpTestAllowed(request({},remote)),true);
 for(const host of ['localhost','localhost:80','127.0.0.1:3000','[::1]:80'])assert.equal(auth.localHttpTestAllowed(request({host})),true);
 for(const req of [request({},'192.168.1.8'),request({host:'example.com'}),request({},'127.0.0.1','https'),request({origin:'http://evil.example'}),request({host:'localhost.evil.example'})])assert.equal(auth.localHttpTestAllowed(req),false);
 for(const name of ['forwarded','x-forwarded-for','x-forwarded-port','x-forwarded-prefix','x-forwarded-server','cf-connecting-ip','x-real-ip'])
  for(const value of ['','127.0.0.1'])assert.equal(auth.localHttpTestAllowed(request({[name]:value})),false,name);
});
test('local test sessions are explicit, scoped to the same HTTP origin and never reported as DBSC bound',t=>{
 const {auth}=fixture(t),res=response(),result=auth.beginBinding(request(),res);
 assert.equal(result.authenticated,true);assert.equal(result.localTest,true);assert.equal(result.dbscRequired,false);
 assert.equal(res.headers['Secure-Session-Registration'],undefined);
 const proof=cookie(res);assert.ok(proof);assert.match([].concat(res.headers['Set-Cookie']).find(x=>x.startsWith(proof)),/Max-Age=1296000/);
 const session=auth.getSession(request({cookie:proof}));assert.equal(session.localTest,true);assert.equal(session.boundAt,0);
 assert.ok(session.expiresAt-session.createdAt===15*24*60*60*1000);
 assert.equal(auth.sessions()[0].dbscBound,false);assert.equal(auth.sessions()[0].publicKey,undefined);
 for(const req of [request({cookie:proof},'127.0.0.1','https'),request({cookie:proof,host:'example.com'}),request({cookie:proof},'192.168.1.8'),request({cookie:proof,host:'localhost:8080'}),request({cookie:proof,origin:'http://elsewhere'}),request({cookie:proof,'x-forwarded-port':'443'})])assert.equal(auth.isAuthenticated(req),false);
 const fresh=response();assert.equal(auth.refreshDbsc(request({'sec-secure-session-id':JSON.stringify(session.id)}),fresh).status,403);
 assert.deepEqual(fresh.headers,{});
 assert.equal(auth.revokeSession(session.id),true);assert.equal(auth.isAuthenticated(request({cookie:proof})),false);
});
test('local test sessions expire at their 15-day server deadline',t=>{
 const {auth,dir}=fixture(t),res=response();auth.beginBinding(request(),res);const proof=cookie(res);
 const file=path.join(dir,'.admin-dbsc-sessions.json'),sessions=JSON.parse(fs.readFileSync(file,'utf8'));
 sessions[0].expiresAt=Date.now()-1;fs.writeFileSync(file,JSON.stringify(sessions));
 assert.equal(auth.isAuthenticated(request({cookie:proof})),false);
});
test('HTTPS and proxy requests keep the native DBSC pending state and cannot use it as administrator access',t=>{
 const {auth}=fixture(t);
 for(const req of [request({},'127.0.0.1','https'),request({'x-forwarded-proto':'https'}),request({host:'example.com'})]){
  const res=response(),value=auth.beginBinding(req,res);assert.equal(value.pending,true);assert.equal(value.dbscRequired,true);
  assert.equal(value.localTest,undefined);assert.ok(res.headers['Secure-Session-Registration']);
  const pending=[].concat(res.headers['Set-Cookie']).find(x=>x.startsWith('__Host-tunnel_admin_dbsc_pending=')).split(';')[0];
  assert.equal(auth.isAuthenticated(request({cookie:pending})),false);
 }
});
