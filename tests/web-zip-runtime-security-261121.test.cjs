'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');

test('receiving browser hashes the original archive before accepting a server stamp',async()=>{
    const window={};let verificationCalls=0,serverAllows=true;
    const fetch=async(_url,options)=>{verificationCalls++;assert.equal(JSON.parse(options.body).sha256,sha256);
        return {ok:serverAllows,json:async()=>({ok:serverAllows})};};
    vm.runInNewContext(fs.readFileSync(path.join(root,'client/web-zip-runtime.js'),'utf8'),
        {window,crypto:crypto.webcrypto,Uint8Array,Blob,fetch,Date,Math,setTimeout,clearTimeout});
    const archive=new Blob([Buffer.from('verified complete ZIP bytes')]);
    const sha256=crypto.createHash('sha256').update(Buffer.from(await archive.arrayBuffer())).digest('hex');
    const trust={sha256,stamp:'valid-stamp',fileId:'file-id',messageId:'message-id',sessionId:'session-id'};
    assert.equal(await window.WebZipRuntime.verifyArchive(archive,trust),true);
    assert.equal(verificationCalls,1);
    await assert.rejects(window.WebZipRuntime.verifyArchive(new Blob(['tampered bytes']),trust),/摘要不匹配/);
    assert.equal(verificationCalls,1,'tampered archives must not reach server approval');
    serverAllows=false;
    await assert.rejects(window.WebZipRuntime.verifyArchive(archive,trust),/签名无效/);
    await assert.rejects(window.WebZipRuntime.verifyArchive(archive,{...trust,stamp:''}),/签名无效/);
});

test('service worker checks a live server stamp on each executable runtime response',async()=>{
    const events={};let validationCalls=0,serverAllows=true;
    const runtime={id:'runtime-id',expiresAt:Date.now()+60000,entryPath:'index.html',rootPath:'',
        trust:{sha256:'a'.repeat(64),stamp:'signed-stamp',fileId:'f',messageId:'m',sessionId:'s'},
        files:[{path:'index.html',type:'text/html',data:Uint8Array.from(Buffer.from('<h1>signed</h1>'))}]};
    const indexedDB={open(){const request={};queueMicrotask(()=>{
        request.result={close(){},transaction(){return {objectStore(){return {get(id){const r={};queueMicrotask(()=>{r.result=id===runtime.id?runtime:null;r.onsuccess?.();});return r;}};}};}};
        request.onsuccess?.();});return request;}};
    const self={location:{origin:'https://fixture.invalid'},addEventListener:(name,handler)=>{events[name]=handler;}};
    const fetch=async(_url,options)=>{validationCalls++;assert.equal(JSON.parse(options.body).stamp,runtime.trust.stamp);
        return {ok:serverAllows,json:async()=>({ok:serverAllows})};};
    vm.runInNewContext(fs.readFileSync(path.join(root,'service-worker.js'),'utf8'),
        {self,indexedDB,fetch,URL,Request,Response,Uint8Array,ArrayBuffer,queueMicrotask,setTimeout,clearTimeout});
    const request=new Request('https://fixture.invalid/web-zip-runtime/runtime-id/index.html');
    async function load(){let result;events.fetch({request,respondWith:value=>result=value});return result;}
    let response=await load();assert.equal(response.status,200);
    assert.equal(response.headers.get('X-Web-Zip-Runtime'),'1');
    assert.match(await response.text(),/signed/);
    assert.equal(validationCalls,1);
    serverAllows=false;
    response=await load();assert.equal(response.status,403,'a revoked stamp must block cached runtime content');
    assert.equal(validationCalls,2);
    serverAllows=true;runtime.trust.stamp='';
    response=await load();assert.equal(response.status,403,'unsigned runtimes must never execute');
    assert.equal(validationCalls,2,'missing stamps must be rejected before network verification');
});
