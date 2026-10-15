'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createInfraStore}=require('../server/infra-store'),{createTelegramForwardJobs}=require('../server/telegram-forward-jobs');
const {clipName,moment}=require('../server/media-library/clip-name');
const turn=()=>new Promise(setImmediate);
test('magnet registration, repeated share events and deduplicated download counts survive a real database reopen',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dr2t-magnet-'));let store=await createInfraStore({dataDir:dir});t.after(()=>{store.flush?.();store.db.close();fs.rmSync(dir,{recursive:true,force:true});});
    const value={id:'magnet-12345',sessionId:'session-12345',assetId:'asset',createdAt:Date.now()-86400000*90,asset:{name:'文件.bin',size:123},createdByDeviceId:'alice',createdByDeviceName:'甲'};
    store.saveMagnet(value);store.saveMagnet({...value,createdByDeviceId:'bob',createdByDeviceName:'乙'});
    store.recordMagnetDownload(value.id,'download-123');store.recordMagnetDownload(value.id,'download-123');store.recordMagnetDownload(value.id,'download-456');store.db.close();store=await createInfraStore({dataDir:dir});
    assert.equal(store.getMagnet(value.id).asset.name,'文件.bin');assert.equal(store.getMagnet(value.id).downloadCount,2);assert.equal(store.listMagnets()[0].shares.length,2);assert.equal(store.findMagnet(value.sessionId,value.assetId).id,value.id);
    const server=fs.readFileSync('server.js','utf8'),start=server.indexOf('function getMagnetPayload('),end=server.indexOf('\nfunction ',start+1);
    const context=vm.createContext({infraStore:store,magnets:new Map(),sessions:new Map(),getLiveSeedDevices:()=>[]});vm.runInContext(server.slice(start,end),context);
    assert.equal(context.getMagnetPayload(value.id).asset.size,123);assert.equal(context.getMagnetPayload(value.id).seedDevices.length,0,'offline source does not erase a resolvable link');
    store.revokeTunnelMagnets(value.sessionId);assert.equal(context.getMagnetPayload(value.id),null);assert.equal(store.listMagnets()[0].revoked,true);assert.equal(store.recordMagnetDownload(value.id,'download-789'),false);
});
test('Clip names preserve milliseconds, optional remarks, valid components and requested time notation',()=>{
    assert.equal(moment(5103000),'1h25m3');assert.equal(moment(187000),'3m7');assert.equal(moment(3000),'3s');assert.equal(moment(375),'0.375s');
    assert.equal(clipName({id:'abcdefgh-123',name:'会话'},{remark:'备注',startMs:3000,endMs:187000}),'abcdefgh-会话-备注-3s-3m7');
    const plain=clipName({id:'abcdefgh',name:'会话'},{startMs:0,endMs:1000});assert.equal(plain,'abcdefgh-会话-0s-1s');
    assert.ok(!/[/:*?"<>|]/.test(clipName({id:'abcdefg',name:'a/b'},{remark:'<x>',startMs:0,endMs:1})));assert.ok(Buffer.byteLength(clipName({id:'12345678',name:'长'.repeat(999)},{remark:'长'.repeat(999),startMs:0,endMs:1000}))<220);
});
test('cancel before send prevents all delivery; cancel during send retracts known messages and retains unknown outcomes',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dr2t-cancel-'));const delivered=[],retracted=[];let began;
    const running=new Promise(done=>{began=done;});
    const queue=createTelegramForwardJobs({dataDir:dir,autoStart:false,validate:(_s,_t,input)=>({targets:input.targets,fingerprint:'v1'}),
        send:async(_s,_t,input)=>{delivered.push(input.target);if(input.target==='second'){began();await new Promise((_,reject)=>{input.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});}return {chatId:'-1001',messageId:77};},retract:async value=>{retracted.push(value);}});
    t.after(()=>{queue.close();fs.rmSync(dir,{recursive:true,force:true});});
    const first=queue.create('sns','task',{targets:['never']});queue.cancel(first.id);await queue.pump();assert.equal(delivered.length,0);assert.equal(queue.get(first.id).state,'cancelled');
    const job=queue.create('sns','task',{targets:['first','second','third']});const pending=queue.pump();await running;queue.cancel(job.id);await pending;
    assert.deepEqual(delivered,['first','second']);assert.equal(retracted.length,1);assert.equal(retracted[0].messageId,77);const result=queue.get(job.id);assert.equal(result.state,'cancelled');assert.equal(result.targets[0].rollbackState,'retracted');assert.equal(result.targets[1].state,'uncertain');assert.equal(result.targets[2].state,'cancelled');
    queue.cancel(job.id);await queue.pump();assert.equal(retracted.length,1);
});
test('session and Clip remarks persist with version checks; collection uses the same current naming as download',async t=>{
    const {createFixture}=require('./support/media-library-fixture.cjs'),f=createFixture();t.after(()=>f.close());const s=f.service;
    // This is a metadata/optimistic-version test. HTTP and FFmpeg are exercised
    // independently below, rather than making remark tests depend on loopback timing.
    s.processing.probe=async()=>({format:{duration:'4'},streams:[{codec_type:'video',codec_name:'h264'}]});
    const imported=s.createImport({kind:'disk',...f.put('source')},{id:'alice'});await s.pump();const session=s.createSession(imported.id,'会话文件名');
    const saved=s.remark('session',session.id,{remark:'记'.repeat(65535),version:session.version});assert.equal(saved.remark.length,65535);assert.throws(()=>s.remark('session',session.id,{remark:'x'.repeat(65536)}),/REMARK/);assert.throws(()=>s.remark('session',session.id,{remark:'stale',version:session.version}),/VERSION_CONFLICT/);
    const job=s.clip(session.id,{start:.375,end:2});await s.pump();const clip=s.get('result',job.id);s.remark('result',clip.id,{remark:'片段说明',version:clip.version});
    const expected=clipName(s.get('session',session.id),s.get('result',clip.id));const collection=s.collect(clip.id);assert.equal(collection.name,expected);await s.pump();const result=s.get('collection',collection.id);assert.equal(result.state,'ready');assert.equal(result.file.name,expected+'.mp4');assert.equal(s.list('result').length,1);
});
test('real libx265 compression preserves the original candidate, audio and independent parameter variants', {timeout:60000}, async t=>{
    const {createFixture}=require('./support/media-library-fixture.cjs'),{createMediaProcessing,execute}=require('../server/media-library/processing');
    const ffmpeg=process.env.TEST_FFMPEG||'D:/GreenApps/ffmpeg/5.1.2/bin/ffmpeg.exe',engine=createMediaProcessing({ffmpeg,ffprobe:path.join(path.dirname(ffmpeg),'ffprobe.exe')});
    const f=createFixture({processing:engine});t.after(()=>f.close());const file=path.join(f.dataDir,'source.mp4');
    await execute(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=25:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-c:a','aac','-y',file]);
    const s=f.service,resource=s.createImport({kind:'disk',...f.put(fs.readFileSync(file))},{id:'alice'});await s.pump();const session=s.createSession(resource.id,'转码');const clipJob=s.clip(session.id,{start:0,end:1});await s.pump();const clip=s.get('result',clipJob.id),before=fs.readFileSync(s.cache.filename(s.db.get('cache',clip.cacheId,'alice')));
    assert.throws(()=>s.transcode(clip.id,{width:'1;bad',crf:28}),/PARAMETERS/);assert.throws(()=>s.transcode(clip.id,{preset:'-bad'}),/PARAMETERS/);
    for(const crf of [28,30]){const job=s.transcode(clip.id,{width:96,height:64,crf,preset:'ultrafast'});await s.pump();const done=s.get('job',job.id);assert.equal(done.state,'completed',done.error);assert.equal(done.progress,100);const variant=s.get('compression',job.id);assert.equal(variant.params.crf,crf);assert.equal(variant.quality.width,96);const probe=await engine.probe(s.cache.filename(s.db.get('cache',variant.cacheId,'alice')));assert.equal(probe.streams.find(v=>v.codec_type==='video').codec_name,'hevc');assert.equal(probe.streams.find(v=>v.codec_type==='audio').codec_name,'aac');}
    assert.equal(s.list('compression').length,2);assert.deepEqual(fs.readFileSync(s.cache.filename(s.db.get('cache',clip.cacheId,'alice'))),before);
});

test('legacy draft source labels resolve only an unambiguous source tunnel and never copy the current tunnel code',async()=>{
    const app=fs.readFileSync('app.js','utf8'),start=app.indexOf('async function resolveWebWorkshopSourceTunnelLabels('),end=app.indexOf('\nfunction getTransferRecordAnchorUrl(',start);
    const context=vm.createContext({state:{sessionId:'current',shortCode:'LOCAL'},normalizeLocalShortCode:value=>value||'',readSessionDirectoryCache:()=>[],getFromStore:async()=>({sessionId:'other'}),getAllFromStore:async store=>store==='sessions'?[{sessionId:'other',shortCode:'ABCDE'}]:[{sessionId:'other',fileInfo:{id:'only-file'}},{sessionId:'other',fileInfo:{id:'ambiguous'}},{sessionId:'current',fileInfo:{id:'ambiguous'}}]});
    vm.runInContext(app.slice(start,end),context);const labels=await context.resolveWebWorkshopSourceTunnelLabels([{id:'direct',sourceSessionId:'other'},{id:'record',sourceMessageId:'message'},{id:'legacy',sourceFileId:'only-file'},{id:'unknown',sourceFileId:'ambiguous'}]);assert.equal(labels.direct,'来源隧道：ABCDE');assert.equal(labels.record,labels.direct);assert.equal(labels.legacy,labels.direct);assert.equal(labels.unknown,undefined);
});
test('Clip download is protected and uses the same current name as collection, without changing cache bytes',async t=>{
    const express=require('express'),{createMediaRoutes}=require('../server/media-library/routes'),{createFixture}=require('./support/media-library-fixture.cjs');const f=createFixture();t.after(()=>f.close());const s=f.service,resource=s.createImport({kind:'disk',...f.put('video')},{id:'alice'});await s.pump();const session=s.createSession(resource.id,'会话'),clip=s.clip(session.id,{start:.5,end:1});await s.pump();s.remark('result',clip.id,{remark:"备注'测试"});
    const app=express();app.use(express.json());app.use('/api/media-library',createMediaRoutes({service:s,disk:f.disk,downloads:f.downloads,identity:()=>({id:'alice'}),origin:req=>'http://'+req.get('Host'),requireAuth:(req,res,next)=>req.headers['x-admin']==='1'?next():res.sendStatus(401)}));const server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));t.after(()=>new Promise(done=>{server.close(done);server.closeAllConnections();}));
    const url='http://127.0.0.1:'+server.address().port+'/api/media-library/results/'+clip.id+'/download';assert.equal((await fetch(url)).status,401);const response=await fetch(url,{headers:{'x-admin':'1'}});assert.equal(response.status,200);assert.ok(decodeURIComponent(response.headers.get('Content-Disposition')).endsWith(clipName(s.get('session',session.id),s.get('result',clip.id))+'.mp4'));assert.equal(await response.text(),'clip');
});

test('another worker can request cancellation without stealing the live owner; rollback failure remains explicit',async t=>{
    const {DatabaseSync}=require('node:sqlite'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'dr2t-cancel-worker-'));let ready;const waiting=new Promise(done=>{ready=done;});
    const validate=(_s,_t,input)=>({targets:input.targets,fingerprint:'v'}),q=createTelegramForwardJobs({dataDir:dir,autoStart:false,validate,
        send:async(_s,_t,input)=>{if(input.target==='second'){ready();await new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}return {chatId:'-1001',messageId:1};},retract:async()=>{throw Error('权限不足，无法撤回');}});
    const q2=createTelegramForwardJobs({dataDir:dir,autoStart:false,validate,send:async()=>{throw Error('must not send');}});t.after(()=>{q2.close();q.close();fs.rmSync(dir,{recursive:true,force:true});});
    const job=q.create('sns','task',{targets:['first','second','third']}),running=q.pump();await waiting;
    const db=new DatabaseSync(path.join(dir,'telegram-forward.sqlite'));const pid=db.prepare('SELECT pid FROM forward_jobs WHERE id=?').get(job.id).pid;q2.cancel(job.id);assert.equal(db.prepare('SELECT pid FROM forward_jobs WHERE id=?').get(job.id).pid,pid);db.close();
    await running;const done=q.get(job.id);assert.equal(done.state,'cancelled');assert.equal(done.targets[0].rollbackState,'failed');assert.match(done.targets[0].rollbackError,/权限不足/);assert.equal(done.targets[2].state,'cancelled');
});
test('compression allocation failure clears its partial reservation and releases the original candidate lease',async t=>{
    const {createFixture}=require('./support/media-library-fixture.cjs'),f=createFixture();t.after(()=>f.close());const s=f.service,resource=s.createImport({kind:'disk',...f.put('source')},{id:'alice'});await s.pump();const session=s.createSession(resource.id,'测试'),clip=s.clip(session.id,{start:0,end:1});await s.pump();
    const allocate=s.cache.allocate;let calls=0;s.cache.allocate=(...args)=>{if(++calls===2)throw Error('MEDIA_CACHE_CAPACITY_EXCEEDED');return allocate(...args);};
    const job=s.transcode(clip.id,{});await s.pump();assert.equal(s.get('job',job.id).state,'failed');assert.equal(s.get('job',job.id).error,'MEDIA_CACHE_CAPACITY_EXCEEDED');assert.equal(s.list('cache').filter(c=>c.status==='reserved').length,0);
    const original=s.db.get('cache',s.get('result',clip.id).cacheId,'alice');assert.equal(original.status,'ready');assert.equal(original.leases.length,0);
});
