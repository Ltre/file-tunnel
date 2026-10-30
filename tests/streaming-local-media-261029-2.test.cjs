'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync('client/streaming-console.js','utf8');
function fixture(){
    const reads=[],fallbacks=[],urls=[],controller=new AbortController();
    const item={id:'item',name:'本机.jpg',size:12,kind:'image',sourceKind:'local'};
    const baseline={configVersion:3,items:[{...item,source:{kind:'local',fileId:'file',name:item.name,size:item.size}}]};
    const ctx={config:{deviceId:()=> 'fixture-device'},localConfig:()=>baseline,localBlob:async source=>{reads.push(source);return new Blob([new Uint8Array(item.size)]);},
        peerMedia:{url:async access=>{fallbacks.push(access);return access.url;}},request(){throw Error('not called');},URL:{createObjectURL:blob=>{urls.push(blob);return 'blob:local';}}};
    vm.runInNewContext(code.slice(code.indexOf('    async function playbackUrl('),code.indexOf('    async function providerLoop(')),ctx);
    return {ctx,item,baseline,controller,reads,fallbacks,urls,state:{id:'station',local:true,configVersion:3},resolve(){return ctx.playbackUrl({url:'/authorized-media'},controller.signal,item,this.state,'original-account');}};
}
test('the current source device reads only its matching saved local item',async()=>{
    const f=fixture();assert.equal(await f.resolve(),'blob:local');assert.equal(f.reads[0].fileId,'file');assert.equal(f.fallbacks.length,0);
});
test('a matching cached tunnel program uses the local-only reader after ticket authorization',async()=>{
 const f=fixture();f.item.sourceKind='tunnel';f.baseline.items[0].source.kind='tunnel';let reads=0;
 f.ctx.config.readTunnel=async(_source,options)=>{reads++;assert.equal(options.localOnly,true);return new Blob([new Uint8Array(12)]);};
 assert.equal(await f.resolve(),'blob:local');assert.equal(reads,1);assert.equal(f.fallbacks.length,0);
});
for(const mismatch of ['device','version','name','size','kind','sourceKind','missing item'])test('local '+mismatch+' mismatch retains the established authorized transport',async()=>{
    const f=fixture();
    if(mismatch==='device')f.state.local=false;else if(mismatch==='version')f.state.configVersion++;
    else if(mismatch==='missing item')f.baseline.items=[];else f.item[mismatch]+='changed';
    assert.equal(await f.resolve(),'/authorized-media');assert.equal(f.reads.length,0);assert.equal(f.fallbacks.length,1);
});
test('a missing local file falls back without changing account or source state',async()=>{
    const f=fixture();f.ctx.localBlob=async()=>{throw Error('missing');};assert.equal(await f.resolve(),'/authorized-media');assert.equal(f.urls.length,0);
});
test('changed local bytes cannot reuse an authorized old-size program ticket',async()=>{
    const f=fixture();f.ctx.localBlob=async()=>new Blob(['changed bytes']);assert.equal(await f.resolve(),'/authorized-media');assert.equal(f.urls.length,0);assert.equal(f.fallbacks.length,1);
});
test('a canceled local read creates no URL and starts no fallback transport',async()=>{
    const f=fixture();f.ctx.localBlob=async()=>{f.controller.abort();return new Blob(['bytes']);};await assert.rejects(f.resolve(),/STREAM_READ_CANCELLED/);assert.equal(f.urls.length,0);assert.equal(f.fallbacks.length,0);
});
test('an in-session standard file does not wait for an IndexedDB handle lookup',async()=>{
    let lookedUp=false;const blob=new Blob(['bytes']),ctx={global:{},localFiles:new Map([['local',{file:blob}]]),handleStore(){lookedUp=true;return new Promise(()=>{});}};
    vm.runInNewContext(code.slice(code.indexOf('    async function localBlob('),code.indexOf('    let peerMedia;')),ctx);
    assert.equal(await ctx.localBlob({fileId:'local'}),blob);assert.equal(lookedUp,false);
});
