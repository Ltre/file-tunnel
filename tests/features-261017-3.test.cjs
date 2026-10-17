'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createFixture}=require('./support/media-library-fixture.cjs');
const {createMediaProcessing,execute,durationOf}=require('../server/media-library/processing');
const {createTunnelAccess}=require('../server/tunnel-access');
function removeFixtureDirectory(directory,prefix){const target=path.resolve(directory);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith(prefix))throw Error('unsafe fixture cleanup');fs.rmSync(target,{recursive:true,force:true});}
async function setup(t){const f=createFixture();t.after(()=>f.close());const s=f.service;const resource=s.createImport({kind:'disk',...f.put('source')},{id:'alice'});await s.pump();return {...f,s,resource,session:s.createSession(resource.id,'删除验收')};}
test('deleting a Clip removes all local compression versions and thumbnails while retaining saved collections and unrelated files',async t=>{
    const f=await setup(t),{s}=f,job=s.clip(f.session.id,{start:0,end:1});await s.pump();const result=s.get('result',job.id);
    s.processing.compress=async(_i,out)=>{fs.writeFileSync(out,'compressed');return {bytes:10};};s.processing.thumbnail=async(_i,out)=>fs.writeFileSync(out,'thumb');
    const versions=[];for(let i=0;i<2;i++){const task=s.transcode(result.id,{});await s.pump();versions.push(s.get('compression',task.id));}
    const collection=s.collect(result.id,{});await s.pump();const saved=s.get('collection',collection.id).file;
    const other=s.cache.allocate('alice','candidates',s.config().caches.candidates,undefined,'.jpg');fs.writeFileSync(other.path,'unrelated');s.cache.commit('alice',other.record.id,s.config().caches.candidates);
    const owned=[result.cacheId,...versions.flatMap(v=>[v.cacheId,v.thumbnailCacheId])];
    s.removeResult(result.id);
    assert.equal(s.list('result').some(r=>r.id===result.id),false);
    for(const id of owned){const c=s.db.get('cache',id,'alice');assert.equal(c.status,'cleared');assert.equal(fs.existsSync(s.cache.filename(c)),false);}
    assert.equal(s.list('compression').some(v=>v.resultId===result.id),false);assert.ok(f.files.has(saved.fileId));assert.ok(fs.existsSync(other.path));
    assert.throws(()=>s.transcode(result.id,{}),/NOT_FOUND/);
});
test('deleting screenshots releases their cache, preserves references and prevents failed batch retries from recreating deleted frames',async t=>{
    const {s,session}=await setup(t);const task=s.extract(session.id,{mode:'interval',ranges:'0-1',intervalMs:500});await s.pump();const images=s.list('result');
    const lease=s.cache.acquire('alice',images[0].cacheId);assert.throws(()=>s.removeResult(images[0].id),/IN_USE/);lease.release();
    s.removeResult(images[0].id);s.db.patch('job',task.job.id,'alice',{state:'failed'});s.retry(task.job.id);await s.pump();
    assert.equal(s.list('result').length,1);assert.equal(s.list('result')[0].id,images[1].id);
    assert.deepEqual(s.compare(images[1].id,{against:'session',threshold:0}),[],'deleted frames must not reappear in comparison results');
});

test('candidate deletion protects queued collection writes and cache files referenced by another live result',async t=>{
    const {s,session}=await setup(t),task=s.clip(session.id,{start:0,end:1});await s.pump();const result=s.get('result',task.id);
    s.collect(result.id);assert.throws(()=>s.removeResult(result.id),/MEDIA_RESULT_BUSY/);await s.pump();
    const shared=s.db.create('result','alice',{sessionId:session.id,kind:'clip',cacheId:result.cacheId});
    s.removeResult(result.id);const lease=s.cache.acquire('alice',shared.cacheId);assert.equal(lease.record.status,'ready');lease.release();
});
test('frame extraction can confirm the last visible frame when a request lies after its PTS but inside video duration',{timeout:30000},async t=>{
    const ffmpeg=process.env.TEST_FFMPEG||'D:/GreenApps/ffmpeg/5.1.2/bin/ffmpeg.exe';if(!fs.existsSync(ffmpeg))return t.skip('real FFmpeg unavailable');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dr2t-frame-tail-'));t.after(()=>removeFixtureDirectory(dir,'dr2t-frame-tail-'));
    const source=path.join(dir,'source.mp4');await execute(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=25:duration=2','-c:v','libx264','-y',source]);
    let calls=0;const engine=createMediaProcessing({ffmpeg,ffprobe:path.join(path.dirname(ffmpeg),'ffprobe.exe'),run:(...args)=>{calls++;return execute(...args);}}),probe=await engine.probe(source);
    const frame=await engine.frame(source,1.999,path.join(dir,'last.jpg'),probe);assert.equal(frame.actualMs,1960);assert.equal(frame.requestedMs,1999);assert.ok(frame.dHash);assert.ok(calls<=4,'normal extraction must not launch three decoders per screenshot');
});

test('retired codes only upgrade snapshotted legacy members once, survive restart, and never authenticate by device ID alone',t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dr2t-legacy-access-'));t.after(()=>removeFixtureDirectory(dir,'dr2t-legacy-access-'));
    let access=createTunnelAccess(dir);access.issue('tunnel','enrolled');access.preserveLegacy('tunnel','OLD51',['legacy','enrolled']);
    access=createTunnelAccess(dir);assert.equal(access.verifyLegacy('tunnel','legacy','OLD51'),true);
    for(const [tunnel,device,code]of [['other','legacy','OLD51'],['tunnel','unknown','OLD51'],['tunnel','legacy','WRONG'],['tunnel','enrolled','OLD51'],['tunnel','legacy','']])assert.equal(access.verifyLegacy(tunnel,device,code),false);
    const grant=access.issue('tunnel','legacy');assert.equal(access.verifyLegacy('tunnel','legacy','OLD51'),false);assert.equal(createTunnelAccess(dir).verify(grant,'tunnel','legacy'),true);
    assert.equal(fs.readFileSync(path.join(dir,'.tunnel-access-legacy'),'utf8').includes('OLD51'),false);
});

test('24-frame real extraction confirms timestamps with nonzero origins, B frames, variable frame rates and long GOPs',{timeout:60000},async t=>{
    const ffmpeg=process.env.TEST_FFMPEG||'D:/GreenApps/ffmpeg/5.1.2/bin/ffmpeg.exe';if(!fs.existsSync(ffmpeg))return t.skip('real FFmpeg unavailable');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dr2t-frame-matrix-'));t.after(()=>removeFixtureDirectory(dir,'dr2t-frame-matrix-'));
    const engine=createMediaProcessing({ffmpeg,ffprobe:path.join(path.dirname(ffmpeg),'ffprobe.exe')});
    for(const [name,filters,origin]of [['offset',[],'2'],['vfr',['-vf',"select='not(mod(n,2))+not(mod(n,5))'",'-fps_mode','vfr'],'0']]){
        const source=path.join(dir,name+'.mp4');await execute(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=25:duration=8',...filters,'-c:v','libx264','-g','500','-keyint_min','500','-sc_threshold','0','-output_ts_offset',origin,'-y',source]);
        const probe=await engine.probe(source),duration=durationOf(probe),started=Date.now();
        for(let index=0;index<24;index++){
            const requested=index===23?duration-.001:index*duration/24;
            const result=await engine.frame(source,requested,path.join(dir,name+'-'+index+'.jpg'),probe);
            assert.ok(Number.isFinite(result.actualMs)&&result.actualMs>=0&&result.actualMs<duration*1000);
            assert.ok(Math.abs(result.actualMs-requested*1000)<100,'actual PTS must remain on the source timeline');
        }
        t.diagnostic(name+': 24/24 confirmed in '+(Date.now()-started)+'ms');
    }
});

test('admin overview resolves renamed opaque partitions by owner and stable scope, without renaming routing keys',async t=>{
    const express=require('express'),{createDiskAuth}=require('../server/disk-auth'),{createDiskAPI}=require('../server/disk-api'),{createDiskOperations}=require('../server/disk-operations');
    const {createTelegramDriveStore}=require('../server/telegram-drive'),{createDiskPartitions}=require('../server/disk-partitions');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dr2t-partition-label-'));const auth=createDiskAuth({dataDir:dir}),user=auth.fromTelegram({id:'999000001',username:'label-fixture'});
    const api=createDiskAPI({dataDir:dir,defaultStore:createTelegramDriveStore({dataDir:dir}),auth,operations:createDiskOperations({dataDir:dir}),telegram:{call:async()=>({}),upload:async()=>[],validate:async()=>({})},getDefaultBackend:()=>({token:'fixture',channelId:'-1',baseUrl:'https://fixture.invalid'}),getIdentity:()=>user,setIdentity(){},getOrigin:()=> 'http://localhost',isMockRequest:()=>true,maxDepth:()=>20});
    const partitions=createDiskPartitions({dataDir:dir,spaces:api.spaces}),partition=partitions.createWithin(user.id,'6');api.spaces.track('system',user.id,partition.scopeKey);
    const app=express();app.use('/admin',api.admin);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    t.after(async()=>{await new Promise(resolve=>server.close(resolve));api.close();removeFixtureDirectory(dir,'dr2t-partition-label-');});
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/admin/storage-overview');assert.equal(response.status,200);
    const data=await response.json(),row=data.systems.flatMap(system=>system.users).flatMap(actor=>actor.spaces).find(space=>space.diskSpace===partition.scopeKey);
    assert.equal(row.partitionName,'6');assert.equal(row.partitionId,partition.id);assert.match(row.diskSpace,/^p-/);
});

test('record text selection retains message bodies and remarks while including newline-wrapped file names',async()=>{
    const source=fs.readFileSync('app.js','utf8'),context=vm.createContext({});vm.runInContext(source.slice(source.indexOf('function getCollectionFiles('),source.indexOf('async function createCollectionTileHtml('))+source.slice(source.indexOf('function recordTextPayload('),source.indexOf('async function copyTransferRecordText(')),context);
    assert.equal(context.recordTextPayload({type:'text',text:'第一行\n第二行'}).text,'第一行\n第二行');
    assert.equal(context.recordTextPayload({type:'file',remark:'备注',fileInfo:{name:'现在支持文件名.mp4',remark:'旧备注'}}).text,'备注\n现在支持文件名.mp4\n');
    assert.equal(context.recordTextPayload({type:'collection',collection:{remark:'合辑备注'}}).text,'合辑备注');
    assert.equal(context.recordTextPayload({type:'file',fileInfo:{name:'仅文件名.mp4'}}).text,'\n仅文件名.mp4\n');
});
