'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Readable}=require('node:stream');
const {registerStreamingConsole}=require('../server/streaming-http');
const {createStreamingSources}=require('../server/streaming-sources');
test('Range playback delivers its first bytes without waiting for a full supplier megabyte and retains exact subsequent ranges',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stream-media-261026-'));
    const body=Buffer.alloc(1024*1024+17,37),metadata={name:'fixture.mp4',type:'video/mp4',size:body.length};
    const sources=createStreamingSources({disk:{resolve:()=>({source:{kind:'disk',fileId:'fixture'},...metadata}),stat:()=>metadata,
        async read(_source,start,end,signal){await new Promise((resolve,reject)=>{const timer=setTimeout(done,Math.ceil((end-start+1)/1024));function done(){signal?.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);reject(Error('STREAM_READ_CANCELLED'));}signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});return Readable.from([body.subarray(start,end+1)]);}},tunnel:{}});
    const app=require('express')();app.use(require('express').json());
    const api=registerStreamingConsole(app,{dataDir:dir,identity:()=>null,proofs:()=>[],user:()=>null,visibleDevices:()=>[],origin:req=>'http://'+req.get('host'),sources,tunnel:{}});
    const actor={deviceId:'device',userId:null,logins:[]};api.service.register('device','x'.repeat(40),'Fixture');
    const station=api.service.create(actor,{name:'Range startup fixture'});
    await api.service.edit(station.id,actor,{configVersion:1,loop:true,items:[{id:'video',duration:60,source:{kind:'disk',fileId:'fixture'}}]});
    api.service.visibility(station.id,actor,{visibility:'public',version:api.service.station(station.id).playback.version});
    const server=await require('./support/listen-http.cjs').listenHttp(app),base='http://127.0.0.1:'+server.address().port,headers={'X-Stream-Device':'device','X-Stream-Key':'x'.repeat(40)};
    t.after(async()=>{api.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('stream-media-261026-'));fs.rmSync(dir,{recursive:true,force:true});});
    const ticket=await (await fetch(base+'/api/streaming/stations/'+station.id+'/ticket',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({itemId:'video'})})).json();
    const started=performance.now(),response=await fetch(base+ticket.url,{headers:{...headers,Range:'bytes=0-'}}),reader=response.body.getReader(),first=await reader.read(),firstByteMs=performance.now()-started;
    assert.equal(response.status,206);assert.equal(response.headers.get('Content-Range'),`bytes 0-${body.length-1}/${body.length}`);
    assert.ok(first.value?.length);const chunks=[first.value];while(true){const part=await reader.read();if(part.done)break;chunks.push(part.value);}assert.deepEqual(Buffer.concat(chunks),body);
    t.diagnostic('paced supplier first byte: '+firstByteMs.toFixed(1)+' ms');
    assert.ok(firstByteMs<600,'first bytes should arrive before the paced supplier has transferred 1 MiB; actual '+firstByteMs.toFixed(1)+' ms');
    const tail=await fetch(base+ticket.url,{headers:{...headers,Range:'bytes=-17'}});assert.equal(tail.status,206);assert.deepEqual(Buffer.from(await tail.arrayBuffer()),body.subarray(-17));
});
