'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events'),{Readable}=require('node:stream');
const {createVideoTranscodeService}=require('../server/video-transcode');

test('running transcodes expose CR-delimited logs and measured intermediate progress before completion',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'transcode-progress-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    let child,args;
    const service=createVideoTranscodeService({dataDir:dir,spawnProcess:(_command,argv)=>{args=argv;child=new EventEmitter();child.stderr=new EventEmitter();return child;}});
    const created=service.createTask({profileId:'h265-clip-scale',params:{START_TIME:'10',END_TIME:'30'},fileName:'sample.mp4',size:4});
    const input=Readable.from(Buffer.from('test'));input.headers={'content-length':'4'};await service.receiveInput(created.id,input);service.startTask(created.id);
    child.stderr.emit('data',Buffer.from('  Duration: 00:01:00.00, start: 0.0\n    DURATION : 00:01:00\nframe=1 time=00:00:05.00 speed=1x\r'));
    let task=service.listTasks()[0];assert.equal(task.status,'running');assert.ok(task.progress>0&&task.progress<100,JSON.stringify(task));assert.ok(task.logs.some(line=>line.includes('frame=1')));
    const first=task.progress;child.stderr.emit('data',Buffer.from('frame=2 time=00:00:15'));child.stderr.emit('data',Buffer.from('.00 speed=1x\r'));
    task=service.listTasks()[0];assert.ok(task.progress>first);assert.ok(task.logs.some(line=>line.includes('time=00:00:15.00')));
    child.stderr.emit('data',Buffer.from('frame=3 time=00:00:25.00 speed=1x\r'));assert.ok(service.listTasks()[0].progress<100,'100% requires a successful process and output');
    child.stderr.emit('data',Buffer.from('trailing diagnostic without newline'));fs.writeFileSync(args.at(-1),'done');child.emit('exit',0,null);
    await new Promise(resolve=>setImmediate(resolve));task=service.listTasks()[0];assert.equal(task.status,'completed');assert.equal(task.progress,100);assert.ok(task.logs.includes('trailing diagnostic without newline'));
});

test('real FFmpeg exposes multiple intermediate updates and logs while it is still encoding',{skip:!process.env.TEST_FFMPEG,timeout:20000},async t=>{
    const {execFileSync}=require('node:child_process'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'transcode-live-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const source=path.join(dir,'source.mkv'),ffmpeg=process.env.TEST_FFMPEG;
    execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=128x72:rate=10','-t','4','-c:v','libx264',source],{windowsHide:true,stdio:'pipe'});
    const service=createVideoTranscodeService({dataDir:dir,ffmpegCommand:ffmpeg});
    service.saveProfile({id:'live-progress',name:'isolated live progress',fields:[],steps:[{name:'encode',args:['-re','-i','${INPUT_FILE}','-c:v','libx265','-preset','ultrafast','-tune','zerolatency','${OUTPUT_FILE}']}],output:{extension:'mkv'}});
    const task=await service.createSourceTask({profileId:'live-progress'},{path:source,name:'test.mkv'}),seen=new Set();let logWhileRunning=false;
    for(let n=0;n<150;n++){const current=service.listTasks().find(item=>item.id===task.id);if(current.status==='completed')break;assert.notEqual(current.status,'failed',current.error);if(current.progress>0&&current.progress<100)seen.add(current.progress);if(current.logs.some(line=>/time=/.test(line)))logWhileRunning=true;await new Promise(resolve=>setTimeout(resolve,80));}
    assert.equal(service.getTask(task.id).status,'completed');assert.ok(seen.size>=2,[...seen].join(','));assert.equal(logWhileRunning,true);
});
