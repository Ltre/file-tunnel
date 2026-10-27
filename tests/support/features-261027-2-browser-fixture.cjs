'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createFixture}=require('./streaming-console-fixture.cjs');
async function create(){
    const f=await createFixture({media:true,serviceWorker:true}),owner={deviceId:'device-A',userId:null,logins:[]};
    f.streaming.service.register('device-A','device-A'.repeat(8),'隔离音视频供源');
    const files=f.sourceFiles.filter(file=>/^(audio|video)\//.test(file.type));
    for(const [i,file]of files.entries())f.records.push({id:'av-'+i,type:'file',fileInfo:{id:'asset-'+i,name:file.name,type:file.type,size:file.body.length,data:'data:'+file.type+';base64,'+file.body.toString('base64')}});
    const station=f.streaming.service.create(owner,{name:'全屏与小窗音视频验收',creationId:'av-check-261027-2'});
    await f.streaming.service.edit(station.id,owner,{configVersion:1,loop:true,items:files.map((file,i)=>({id:'av-'+i,duration:i===0?6:5,stay:10,source:{kind:'tunnel',sessionId:'fixture-tunnel',messageId:'av-'+i,fileId:'asset-'+i,accessGrant:'fixture-proof'}}))});
    f.streaming.service.visibility(station.id,owner,{visibility:'public',version:f.streaming.service.station(station.id).playback.version});
    f.app.get('/av-check',(_req,res)=>res.type('html').send(fs.readFileSync(path.resolve(__dirname,'../../pages/index.html'),'utf8').replace('<head>','<head><script src="/fixture-bootstrap.js"></script>')));
    for(const [route,src,width,height]of [['wide-player-check','/av-check',1366,900],['wide-layout-check','/streaming-layout-check',1307,818],['phone-import-check','/console',390,720]]){
        f.app.get('/'+route,(_req,res)=>res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#ddd"><iframe title="${width} CSS像素隔离验收" src="${src}" style="width:${width}px;height:${height}px;border:0;transform:scale(${width>1000?.45:1});transform-origin:0 0;background:white"></iframe></body>`));
    }
    f.app.get('/admin-home-check',(_req,res)=>res.type('html').send(fs.readFileSync(path.resolve(__dirname,'../../pages/admin.html'),'utf8')));
    f.app.get('/peer-check/:role',(req,res)=>{
        const provider=req.params.role==='provider',device=provider?'device-A':'device-B',file=files[0];
        res.type('html').send(`<!doctype html><meta charset="utf-8"><h1>${provider?'局域网供源页':'未加入来源隧道的观看页'}</h1><p id="status">初始化</p><p id="bytes">直传字节：0</p><button id="start">请求节目 Range</button><script src="/client/streaming-peers.js"></script><script>
        const device=${JSON.stringify(device)},secret=device.repeat(8);let supplied=0;
        async function request(route,method='GET',body,options={}){const response=await fetch('/api/streaming'+route,{method,headers:{'Content-Type':'application/json','X-Stream-Device':device,'X-Stream-Key':secret,...options.headers},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(data.error);return data;}
        const blobs=${JSON.stringify(files.map((file,i)=>({id:'asset-'+i,data:file.body.toString('base64')})))}.map(file=>({id:file.id,blob:new Blob([Uint8Array.from(atob(file.data),v=>v.charCodeAt(0))])}));
        const peer=StreamingPeers.create({request,readSource:async(source,range)=>{const blob=blobs.find(file=>file.id===source.fileId)?.blob;if(!${provider}||!blob)throw Error('not joined');supplied+=range.end-range.start+1;document.getElementById('bytes').textContent='直传字节：'+supplied;return blob.slice(range.start,range.end+1);}});
        (async()=>{await request('/devices','POST',{deviceId:device,key:secret,name:device});await navigator.serviceWorker.register('/service-worker.js');await navigator.serviceWorker.ready;document.getElementById('status').textContent='已准备';for(;;){const work=await request('/provider-work','GET',undefined,{headers:{'X-Stream-Wait':'1000','X-Stream-Provider':device,...peer.headers()}});peer.accept(work.offers);await new Promise(r=>setTimeout(r,250));}})().catch(e=>document.getElementById('status').textContent=e.message);
        document.getElementById('start').onclick=async()=>{try{const access=await request('/stations/${station.id}/ticket','POST',{itemId:'av-0'}),url=await peer.url(access,request);const response=await fetch(url,{headers:{Range:'bytes=0-65535'}}),bytes=new Uint8Array(await response.arrayBuffer());document.getElementById('status').textContent='Range '+response.status+' · '+bytes.length+' 字节 · '+(url.startsWith('/streaming-peer-media/')?'P2P 优先':url.startsWith('blob:')?'P2P 文件':'HTTP');}catch(e){document.getElementById('status').textContent=e.message;}};
        </script>`);
    });
    return f;
}
module.exports={create};
if(require.main===module)create().then(f=>{console.log(JSON.stringify({base:f.base,dataDir:f.dataDir}));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>f.close().then(()=>process.exit()));});
