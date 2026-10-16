'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { createFixture } = require('./support/media-library-fixture.cjs');
const { createMediaLibrary } = require('../server/media-library/service');
const { clipName, compressionName } = require('../server/media-library/clip-name');
const probe = { format: { duration:'4' }, streams:[{codec_type:'video',codec_name:'h264'},{codec_type:'audio',codec_name:'aac'}] };
async function setup() {
    const f = createFixture(), s = f.service; s.processing.probe = async () => probe;
    s.processing.compress = async (_input,output) => {fs.writeFileSync(output,'compressed');return {width:160,height:90,duration:1};};
    s.processing.thumbnail = async (_input,output) => fs.writeFileSync(output,'thumbnail');
    const resource = s.createImport({kind:'disk',...f.put('source')},{id:'alice'}); await s.pump();
    return {...f,s,resource,session:s.createSession(resource.id,'同名片段')};
}
async function drain(s) { for(let n=0;n<40;n++){if(!s.list('job').some(j=>j.state==='queued'))return;await s.pump();}throw Error('queue did not drain'); }
async function candidate(f,session=f.session) { const job=f.s.clip(session.id,{start:0,end:1});await f.s.pump();return f.s.get('result',job.id); }
async function compressed(f,result) { const job=f.s.transcode(result.id,{});await f.s.pump();return f.s.get('compression',job.id); }
function enforceNameOwnership(f) {
    const write = f.disk.write;
    f.disk.write = async (location,local,name,producer,...rest) => {
        const existing = [...f.files.values()].find(file=>file.ref.userId===location.userId&&file.ref.diskSpace===location.diskSpace&&file.ref.path===location.path&&file.ref.name===name);
        if(existing&&existing.producer!==producer)throw Error('MEDIA_OUTPUT_NAME_CONFLICT');
        return write(location,local,name,producer,...rest);
    };
}

test('identical Clip ranges get distinct persisted IDs in compression download and disk collection names',async t=>{
    const f=await setup();t.after(()=>f.close());enforceNameOwnership(f);
    const first=await candidate(f),second=await candidate(f);assert.equal(first.clipOrdinal,1);assert.equal(second.clipOrdinal,2);
    const a=await compressed(f,first),b=await compressed(f,second);assert.equal(a.ordinal,1);assert.equal(b.ordinal,1);
    const names=[compressionName(f.session,first,a),compressionName(f.session,second,b)];
    assert.match(names[0],/-0s-1s-CLIP1-压1-160x90$/);assert.match(names[1],/-0s-1s-CLIP2-压1-160x90$/);
    const saved=[f.s.collectCompression(a.id),f.s.collectCompression(b.id)];await drain(f.s);
    for(let index=0;index<2;index++){const item=f.s.get('collection',saved[index].id);assert.equal(item.state,'ready');assert.equal(item.file.name,names[index]+'.mkv');}
    assert.equal(f.s.collectCompression(a.id).id,saved[0].id,'same version reuses its saved record');
    const express=require('express'),{createMediaRoutes}=require('../server/media-library/routes'),app=express();app.use(express.json());
    app.use('/media',createMediaRoutes({service:f.s,disk:f.disk,downloads:f.downloads,identity:()=>({id:'alice'}),requireAuth:(req,res,next)=>req.get('X-Admin')==='1'?next():res.sendStatus(401),origin:()=> 'http://localhost'}));
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
    for(const [index,version] of [a,b].entries()){
        const url='http://127.0.0.1:'+server.address().port+'/media/compressions/'+version.id+'/download';
        assert.equal((await fetch(url)).status,401);
        const reply=await fetch(url,{headers:{'X-Admin':'1'}});assert.equal(reply.status,200);assert.ok(decodeURIComponent(reply.headers.get('Content-Disposition')).endsWith(names[index]+'.mkv'));assert.equal(await reply.text(),'compressed');
    }
    const other=f.s.createSession(f.resource.id,'另一个会话');assert.equal((await candidate(f,other)).clipOrdinal,1);
    const again=await compressed(f,first);assert.equal(again.ordinal,2);assert.match(compressionName(f.session,first,again),/-CLIP1-压2-/);
});

test('failed generation rolls back numbering, segments do not count, and regenerated cache keeps the Clip identity',async t=>{
    const f=await setup();t.after(()=>f.close());const s=f.s,create=s.db.create;
    let fail=true;s.db.create=(kind,...args)=>{if(kind==='result'&&fail){fail=false;throw Error('commit failed');}return create(kind,...args);};
    const job=s.clip(f.session.id,{start:0,end:1});await s.pump();assert.equal(s.get('job',job.id).state,'failed');assert.equal(s.get('session',f.session.id).clipOrdinalCounter,0);
    s.retry(job.id);await s.pump();const first=s.get('result',job.id);assert.equal(first.clipOrdinal,1);
    const segment=s.clip(f.session.id,{start:1,end:2},true);await s.pump();assert.equal(s.get('job',segment.id).state,'completed');assert.equal(s.get('session',f.session.id).clipOrdinalCounter,1);
    s.db.patch('cache',first.cacheId,'alice',{status:'expired'});s.db.patch('job',job.id,'alice',{state:'interrupted'});f.advance(1000);s.retry(job.id);await s.pump();
    assert.equal(s.get('result',job.id).clipOrdinal,1);assert.equal((await candidate(f)).clipOrdinal,2);
    const highest=s.list('result').find(r=>r.clipOrdinal===2);s.db.remove('result',highest.id,'alice');assert.equal((await candidate(f)).clipOrdinal,3,'a removed number must not be reused');
});

test('two workers preserve the serialized queue claim and share the committed session sequence',async t=>{
    const f=await setup();let other;t.after(async()=>{await other?.close();await f.close();});
    const first=f.s.clip(f.session.id,{start:0,end:1});f.advance(1);const second=f.s.clip(f.session.id,{start:1,end:2});
    const cut=f.s.processing.cut;let enter;const entered=new Promise(resolve=>{enter=resolve;});let release;const waiting=new Promise(resolve=>{release=resolve;});
    f.s.processing.cut=async(...args)=>{if(args[1]===0){enter();await waiting;}return cut(...args);};
    other=createMediaLibrary({dataDir:f.dataDir,disk:f.disk,downloads:f.downloads,processing:f.s.processing,autoStart:false});
    const processing=f.s.pump();await entered;await other.pump();assert.equal(f.s.get('job',second.id).state,'queued','a second worker cannot steal the active scope queue');release();await processing;await other.pump();
    assert.equal(f.s.get('result',first.id).clipOrdinal,1);assert.equal(f.s.get('result',second.id).clipOrdinal,2);assert.equal(f.s.get('session',f.session.id).clipOrdinalCounter,2);
});

test('legacy Clip numbers are backfilled in creation order, isolated by account, stable on reopen and preserve existing numbers',async t=>{
    const f=await setup();let reopened;t.after(async()=>{await reopened?.close();await f.close();});const s=f.s,id=f.session.id;
    const legacy=(tenant,sessionId,name,extra={})=>s.db.create('result',tenant,{sessionId,kind:'clip',startMs:0,endMs:1000,...extra},name);
    legacy('alice',id,'z-oldest');f.advance(1);legacy('alice',id,'a-later');legacy('alice',id,'numbered',{clipOrdinal:9});
    s.db.create('result','alice',{sessionId:id,kind:'image'},'image');
    s.db.create('session','bob',{importId:'foreign',state:'active'},id);legacy('bob',id,'a-later');
    await s.close();
    const open=()=>createMediaLibrary({dataDir:f.dataDir,disk:f.disk,downloads:f.downloads,processing:s.processing,autoStart:false});
    reopened=open();assert.equal(reopened.get('result','z-oldest').clipOrdinal,1);assert.equal(reopened.get('result','a-later').clipOrdinal,2);assert.equal(reopened.get('result','numbered').clipOrdinal,9);
    assert.equal(reopened.db.get('result','a-later','bob').clipOrdinal,1);assert.equal(reopened.get('result','image').clipOrdinal,undefined);
    const version=reopened.get('result','z-oldest').version;await reopened.close();reopened=open();assert.equal(reopened.get('result','z-oldest').version,version);
    const next=reopened.clip(id,{start:2,end:3});await reopened.pump();assert.equal(reopened.get('result',next.id).clipOrdinal,10);
});

test('legacy definite name conflicts are renamed on either retry entry, preserving successful and uncertain destinations',async t=>{
    const f=await setup();t.after(()=>f.close());enforceNameOwnership(f);const s=f.s,clips=[],versions=[],records=[];
    for(let n=0;n<3;n++){const result=await candidate(f);clips.push(result);versions.push(await compressed(f,result));}
    const oldName=clipName(f.session,clips[0])+'-压1-160x90';
    for(const version of versions){const saved=s.collectCompression(version.id);s.db.patch('collection',saved.id,'alice',{name:oldName,clipOrdinal:undefined});records.push(saved);await s.pump();}
    assert.equal(s.get('collection',records[0].id).state,'ready');assert.equal(s.get('collection',records[1].id).error,'MEDIA_OUTPUT_NAME_CONFLICT');assert.equal(s.get('collection',records[2].id).error,'MEDIA_OUTPUT_NAME_CONFLICT');
    s.remark('session',f.session.id,{remark:'changed later'});s.db.patch('session',f.session.id,'alice',{name:'改名后的会话'});
    s.collectCompression(versions[1].id);
    const thirdJob=s.list('job').find(job=>job.type==='collect'&&job.context.collectionId===records[2].id);s.retry(thirdJob.id);await drain(s);
    for(let index=1;index<3;index++){const item=s.get('collection',records[index].id);assert.equal(item.state,'ready');assert.equal(item.file.name,oldName.replace('-压1','-CLIP'+(index+1)+'-压1')+'.mkv');}
    assert.equal(s.get('collection',records[0].id).file.name,oldName+'.mkv');
    const uncertainClip=await candidate(f),uncertainVersion=await compressed(f,uncertainClip),uncertain=s.collectCompression(uncertainVersion.id);
    const unknownName=oldName.replace('-压1','-另一次-压1');s.db.patch('collection',uncertain.id,'alice',{name:unknownName,clipOrdinal:undefined});f.failAfterWrite();await s.pump();
    assert.equal(s.get('collection',uncertain.id).error,'MEDIA_WRITE_UNCONFIRMED');const written=f.writes;
    const job=s.list('job').find(job=>job.type==='collect'&&job.context.collectionId===uncertain.id);s.retry(job.id);await s.pump();
    assert.equal(s.get('collection',uncertain.id).file.name,unknownName+'.mkv');assert.equal(f.writes,written,'uncertain write retries retain their original idempotency key');
});
