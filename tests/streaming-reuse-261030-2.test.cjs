'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createStreamingConsole}=require('../server/streaming-console');
test('saving an already verified unchanged source reuses its resolution while preserving revocation checks',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stream-reuse-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let resolves=0,revoked=false;
 const sources={resolve:async source=>{resolves++;return {source:{...source,deviceId:'owner'},name:'image.png',type:'image/png',size:10};},stat:()=>{if(revoked)throw Error('STREAM_SOURCE_REVOKED');return {name:'image.png',type:'image/png',size:10};}};
 const service=createStreamingConsole({dataDir:dir,sources,user:()=>null,visibleDevices:()=>[]}),actor={deviceId:'owner',userId:null,logins:[]};service.register('owner','k'.repeat(40),'Owner');const s=service.create(actor,{});
 const source={kind:'local',fileId:'file',name:'image.png',type:'image/png',size:10};
 const save=stay=>service.edit(s.id,actor,{configVersion:service.station(s.id).configVersion,items:[{id:'item',...(resolves?{}:{source}),stay}]});
 await save(10);await save(12);assert.equal(resolves,1);
 revoked=true;await assert.rejects(save(14),/SOURCE_REVOKED/);assert.equal(service.station(s.id).items[0].stay,12);
});
