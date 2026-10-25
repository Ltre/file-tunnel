'use strict';
const {createFixture}=require('./pending-save-261012-fixture.cjs');
(async () => {
    const ids=['999000001','999000002','999000003'];
    const fixture=await createFixture({serverTransfers:true,extraUsers:ids.map(id=>({id,username:id,name:'本地 Mock 用户 '+id}))});
    console.log(JSON.stringify({base:fixture.base,dataDir:fixture.dataDir,stage:'seeding'}));
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>fixture.close().then(()=>process.exit()));
    for (const id of ids) fixture.store.createDirectory(id,'验收目录',30);
    const source=fixture.store.putMetadataObject(fixture.auth.user(ids[0]),'验收目录','已删除协同来源.txt','text/plain',{},30);
    const jar=new Map();
    async function call(route,body) {
        const response=await fetch(fixture.base+route,{method:'POST',headers:{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),'Content-Type':'application/json'},body:JSON.stringify(body)});
        for(const value of response.headers.getSetCookie()){const [key,token]=value.split(';')[0].split('=');jar.set(key,token);}
        if(!response.ok)throw Error('FIXTURE_SEED_FAILED '+route+' '+response.status+' '+(await response.json()).error);
        return response.headers.get('content-type')?.includes('application/json')?response.json():null;
    }
    let invitation;
    for(const id of ids.slice(1)) {
        await call('/fixture-login',{id:ids[0]});
        invitation=await call('/api/telegram/drive/collaborations/invitations',{kind:'file',fileId:source.id});
        const token=new URL(invitation.url).pathname.split('/').pop();
        await call('/fixture-login',{id});await call('/api/telegram/drive/collaborations/join',{token});
    }
    fixture.store.remove(ids[0],source.id);
    fixture.app.get('/fixture-account/:id',(req,res)=>{fixture.sessions.set(req,res,fixture.auth.user(req.params.id));res.redirect('/disk');});
    fixture.app.get('/fixture-stop',(_req,res)=>{res.json({ok:true});setImmediate(()=>fixture.close().then(()=>process.exit()));});
    console.log(JSON.stringify({base:fixture.base,dataDir:fixture.dataDir,collaboration:invitation.collaboration.id}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
