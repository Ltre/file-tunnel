'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const express=require('express'),{listenHttp}=require('./support/listen-http.cjs');
const source=fs.readFileSync('server.js','utf8');
function rateLimit(){const name=source.match(/const rateLimit = require\('([^']+)'\)/)[1];return require(name.startsWith('.')?path.resolve(name):name);}
async function fixture(t,setup){
 const app=express();app.use(express.json());app.use((req,_res,next)=>{Object.defineProperty(req.socket,'remoteAddress',{value:req.get('Test-Remote-IP')||'198.51.100.1',configurable:true});next();});
 await setup(app);const server=await listenHttp(app);t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 return {app,call:(route,headers={},body)=>fetch('http://127.0.0.1:'+server.address().port+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined})};
}
test('Cloudflare visitors have separate limits; a direct client cannot rotate spoofed forwarding headers',async t=>{
 const start=source.indexOf('const RATE_LIMIT ='),end=source.indexOf('function sendLocalRateLimit(',start),context={sendLocalRateLimit:(req,res)=>res.status(429).json({error:'limited'})};
 vm.runInNewContext(source.slice(start,end)+'this.options=RATE_LIMIT;',context);
 const f=await fixture(t,app=>{app.use(rateLimit()({...context.options,max:2}));app.get('/probe',(req,res)=>res.json({protocol:req.protocol,hostname:req.hostname,trust:req.app.get('trust proxy')}));});
 const headers=ip=>({'Test-Remote-IP':'173.245.48.10','CF-Connecting-IP':ip,'X-Forwarded-For':ip,'X-Forwarded-Proto':'https','X-Forwarded-Host':'untrusted.example'});
 assert.equal((await f.call('/probe',headers('203.0.113.1'))).status,200);assert.equal((await f.call('/probe',headers('203.0.113.1'))).status,200);assert.equal((await f.call('/probe',headers('203.0.113.1'))).status,429);
 const other=await f.call('/probe',headers('203.0.113.2'));assert.equal(other.status,200,'another visitor on the same Cloudflare edge must not inherit the first visitor’s limit');
 const data=await other.json();assert.equal(data.protocol,'http');assert.notEqual(data.hostname,'untrusted.example');assert.equal(data.trust,false,'rate-limit repair does not change origin or authentication-related Express settings');
 for(let n=0;n<3;n++){const response=await f.call('/probe',{'Test-Remote-IP':'198.51.100.10','CF-Connecting-IP':'203.0.113.'+(n+10),'X-Forwarded-For':'203.0.113.'+(n+10)});assert.equal(response.status,n<2?200:429,'untrusted direct forwarding headers cannot change the rate-limit key');}
});
test('real streaming device registration behind Cloudflare no longer logs unexpected forwarded-for validation errors',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf-rate-limit-261101-')),errors=[],original=console.error;let streaming;
 console.error=(...args)=>errors.push(...args);t.after(()=>{console.error=original;streaming?.close();fs.rmSync(dir,{recursive:true,force:true});});
 const f=await fixture(t,app=>{streaming=require('../server/streaming-http').registerStreamingConsole(app,{dataDir:dir,identity:()=>null,proofs:()=>[],user:()=>null,origin:req=>req.protocol+'://'+req.get('host'),visibleDevices:()=>[],sources:{broker:{close(){}}}});});
 const response=await f.call('/api/streaming/devices',{'Test-Remote-IP':'173.245.48.10','CF-Connecting-IP':'203.0.113.8','X-Forwarded-For':'203.0.113.8'},{deviceId:'isolated-device',key:'isolated-device-key'.repeat(4),name:'Fixture'});
 assert.equal(response.status,200);assert.equal(errors.filter(error=>error?.code==='ERR_ERL_UNEXPECTED_X_FORWARDED_FOR').length,0,'both the streaming router and registration limiter must use the trusted client IP key');
});
test('trusted address checks cover IPv6, mapped IPv4, CIDR boundaries and malformed headers',()=>{
 const {clientIpKey}=require('../server/request-rate-limit');
 const key=(remote,headers)=>clientIpKey({socket:{remoteAddress:remote},get:name=>headers[name]});
 for(const remote of ['173.245.48.10','::ffff:173.245.48.10','2606:4700::1'])assert.equal(key(remote,{'cf-connecting-ip':'2001:0db8:0000::1'}),'2001:db8::1');
 for(const remote of ['173.245.47.255','173.245.64.0','198.51.100.9','127.0.0.1'])assert.equal(key(remote,{'cf-connecting-ip':'203.0.113.2','x-forwarded-for':'203.0.113.3'}),remote);
 assert.equal(key('fe80::1%12',{'cf-connecting-ip':'203.0.113.2'}),'fe80::1','a direct scoped IPv6 address is normalized without a URL parsing exception');
 assert.equal(key('173.245.48.10',{'x-forwarded-for':'203.0.113.9, 198.51.100.8, 104.16.0.1'}),'198.51.100.8','the nearest untrusted hop wins, not a spoofed leftmost entry');
 assert.equal(key('173.245.48.10',{'cf-connecting-ip':'bad','x-forwarded-for':'203.0.113.9:1234'}),'173.245.48.10');
 assert.equal(key('173.245.48.10',{'cf-connecting-ip':'203.0.113.2, 203.0.113.3','x-forwarded-for':'bad'}),'173.245.48.10');
});
