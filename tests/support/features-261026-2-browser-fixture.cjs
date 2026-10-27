'use strict';
// Isolated account/drive/streaming APIs and synthetic media only.
const fs=require('node:fs'),path=require('node:path');
const {createFixture}=require('./streaming-console-fixture.cjs');
async function create(){
    const f=await createFixture({media:true});
    const actor={deviceId:'device-A',userId:null,logins:[]};f.streaming.service.register('device-A','device-A'.repeat(8),'隔离来源设备');
    const station=f.streaming.service.create(actor,{name:'发现列表订阅验收',creationId:'discover-subscription-fixture'});
    await f.streaming.service.edit(station.id,actor,{configVersion:1,loop:true,items:[{id:'image',stay:10,source:{kind:'tunnel',sessionId:'fixture-tunnel',messageId:'image-record',fileId:'image-asset',accessGrant:'fixture-proof'}}]});
    f.streaming.service.visibility(station.id,actor,{visibility:'public',version:f.streaming.service.station(station.id).playback.version});
    let failing=false;const read=f.sources.read;
    f.sources.read=(...args)=>{if(failing)throw Error('STREAM_PROVIDER_TIMEOUT');return read(...args);};
    f.app.post('/fixture-source-failure/:state',(req,res)=>{failing=req.params.state==='on';res.json({failing});});
    f.app.get('/fixture-source-controls.js',(_req,res)=>res.type('js').send(`document.addEventListener('DOMContentLoaded',()=>{const controls=document.createElement('div');controls.style='position:fixed;bottom:0;right:0;z-index:50000;background:white;color:black;padding:8px';for(const [state,title]of[['on','模拟供源暂时失败'],['off','恢复隔离供源']]){const b=document.createElement('button');b.textContent=title;b.onclick=async()=>{await fetch('/fixture-source-failure/'+state,{method:'POST'});b.textContent=title+' · 已设置';};controls.append(b);}document.body.append(controls);});`));
    f.app.get('/recovery-check',(_req,res)=>res.type('html').send(fs.readFileSync(path.resolve(__dirname,'../../pages/index.html'),'utf8').replace('<head>','<head><script src="/fixture-bootstrap.js"></script><script src="/fixture-source-controls.js"></script>')));
    return f;
}
module.exports={create};
if(require.main===module)create().then(f=>{console.log(JSON.stringify({base:f.base,dataDir:f.dataDir,browser:f.base+'/fixture-account/alice'}));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>f.close().then(()=>process.exit()));}).catch(error=>{console.error(error);process.exit(1);});
