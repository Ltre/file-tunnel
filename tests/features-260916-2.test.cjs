'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { validateProfile, validateParams, buildArgs, createVideoTranscodeService } = require('../server/video-transcode');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('SNS 片段输入传给任务，且只有片段任务显示音轨修正版', () => {
    const page = source('pages/sns-dl.html');
    assert.match(page, /downloadSections:downloadSectionsInput\.value\.trim\(\)/);
    assert.match(page, /task\.status === 'completed' && task\.hasFile && task\.downloadSections/);
});

test('移动网盘以窄屏布局兜底触摸激活，避免目录名称区域进入 PC 选择', () => {
    assert.match(source('client/disk-ui.js'), /max-width:600px/);
});

test('网页 ZIP 工坊、通知入口和移动控制中心磁贴均已接入', () => {
    const page = source('pages/index.html'), app = source('app.js'), server = source('server.js');
    assert.match(page, /id="webWorkshopBtn"[^>]*>网页工坊/);
    assert.match(page, /id="notificationCenterBtn"[^>]*>通知中心/);
    assert.match(app, /\['notifications', '🔔', '通知中心'/);
    assert.match(app, /\.html\\\.zip\$\/i/);
    assert.match(server, /web-zip-edit-request/);
    assert.match(server, /'\/notification'/);
    assert.match(source('client/web-workshop.js'), /SANDBOX_TTL = 7 \* 24 \* 60 \* 60 \* 1000/);
});

test('网页 ZIP 打包解包保留文件与空目录', async () => {
    const window={};
    vm.runInNewContext(source('client/folder-archive.js'),{window,TextEncoder,TextDecoder,Uint8Array,DataView,Blob,Response,DecompressionStream});
    const files=[{path:'index.html',arrayBuffer:async()=>new TextEncoder().encode('<h1>ok</h1>').buffer},{path:'assets/',arrayBuffer:async()=>new ArrayBuffer(0)}];
    const archive=await window.FolderArchive.createZip(files);const entries=await window.FolderArchive.extractZip(archive);
    assert.deepEqual(Array.from(entries,item=>item.path),['index.html','assets/']);
    assert.equal(new TextDecoder().decode(entries[0].data),'<h1>ok</h1>');
});

test('转码方案按 schema 校验并生成独立 argv，不执行 shell 字符串', () => {
    const profile = validateProfile({
        id:'test-profile', name:'测试方案',
        fields:[{name:'START_TIME',type:'duration',label:'开始'},{name:'CRF',type:'number',label:'CRF',min:0,max:51}],
        rules:[{type:'requireAny',fields:['START_TIME']}],
        steps:[{name:'转码',args:[{when:'START_TIME',values:['-ss','${START_TIME}']},'-i','${INPUT_FILE}','-crf','${CRF}','${OUTPUT_FILE}']}],
        output:{extension:'mp4',nameTemplate:'${BASENAME}.mp4'}
    });
    const values = validateParams(profile,{START_TIME:'00:00:12',CRF:'23'});
    const args = buildArgs(profile.steps[0],{...values,INPUT_FILE:'in.mp4',OUTPUT_FILE:'out.mp4'});
    assert.deepEqual(args,['-ss','00:00:12','-i','in.mp4','-crf','23','out.mp4']);
    assert.throws(()=>validateParams(profile,{START_TIME:'',CRF:'23'}),/至少|填写/);
    assert.throws(()=>validateProfile({...profile,id:'bad profile'}),/INVALID_PROFILE/);
});

test('视频转码服务持久化自定义方案与任务元数据', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'video-transcode-'));
    try {
        const service = createVideoTranscodeService({dataDir:root,ffmpegCommand:'ffmpeg'});
        const custom = service.saveProfile({id:'copy-test',name:'封装测试',fields:[],rules:[],steps:[{name:'复制',args:['-i','${INPUT_FILE}','-c','copy','${OUTPUT_FILE}']}],output:{extension:'mkv',nameTemplate:'${BASENAME}-copy.mkv'}});
        assert.equal(custom.id,'copy-test');
        const task = service.createTask({profileId:'copy-test',params:{},fileName:'demo.mp4',size:4,type:'video/mp4'});
        assert.equal(task.status,'uploading');
        assert.equal(service.listTasks()[0].fileName,'demo.mp4');
        assert.ok(fs.existsSync(path.join(root,'video-transcode-profiles.json')));
        assert.ok(fs.existsSync(path.join(root,'video-transcode-tasks.json')));
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('视频转码服务流式接收源文件并以 argv 队列执行到成品', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'video-transcode-run-'));
    const invocations = [];
    const spawnProcess = (command,args,options) => {
        invocations.push({command,args,options});
        const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => child.emit('exit',null,'SIGTERM');
        setImmediate(() => { fs.writeFileSync(args.at(-1),'done'); child.emit('exit',0,null); }); return child;
    };
    try {
        const service = createVideoTranscodeService({dataDir:root,ffmpegCommand:'ffmpeg-test',spawnProcess});
        const task = service.createTask({profileId:'h265-balanced',params:{CRF:'25',PRESET:'fast'},fileName:'demo.mp4',size:4,type:'video/mp4'});
        const request = Readable.from(Buffer.from('demo')); request.headers = {'content-length':'4'};
        await service.receiveInput(task.id,request); service.startTask(task.id);
        for (let index=0;index<100 && service.getTask(task.id).status!=='completed';index++) await new Promise(resolve=>setTimeout(resolve,5));
        const completed=service.getTask(task.id);assert.equal(completed.status,'completed');assert.ok(fs.existsSync(completed.outputPath));
        assert.equal(invocations[0].command,'ffmpeg-test');assert.equal(invocations[0].options.shell,false);assert.deepEqual(invocations[0].args.slice(0,2),['-y','-i']);
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('后台已接入动态视频转码页和受认证 API', () => {
    const server = source('server.js'), page = source('pages/video-transcode.html');
    assert.match(source('pages/admin.html'), /href="\/video-transcode"/);
    assert.match(server, /registerVideoTranscodeRoutes/);
    assert.match(page, /id="dynamicFields"/);
    assert.match(page, /id="profileJson"/);
    assert.match(page, /api\/video-transcode\/tasks/);
});
