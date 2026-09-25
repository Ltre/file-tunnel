'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SYSTEM_FIELDS = new Set(['INPUT_FILE', 'ORIGINAL_INPUT_FILE', 'OUTPUT_FILE']);
const FIELD_TYPES = new Set(['text', 'number', 'duration', 'scale', 'select', 'boolean']);
const OUTPUT_EXTENSIONS = new Set(['mp4', 'mkv', 'webm', 'mov', 'm4v', 'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg']);

function defaultProfiles() {
    return [{
        id:'h265-balanced', name:'H.265 均衡转码', description:'使用 libx265 转码视频，保留原音轨；编码速度留空时使用 FFmpeg 默认值。', builtin:true,
        fields:[
            { name:'CRF', type:'number', label:'CRF', default:'28', min:0, max:51 },
            { name:'PRESET', type:'select', label:'编码速度', default:'', options:['','ultrafast','veryfast','fast','medium','slow','veryslow'] }
        ], rules:[],
        steps:[{ name:'H.265 转码', args:['-i','${INPUT_FILE}','-c:v','libx265',{when:'CRF',values:['-crf','${CRF}']},{when:'PRESET',values:['-preset','${PRESET}']},'-movflags','+faststart','-c:a','copy','${OUTPUT_FILE}'] }],
        output:{ extension:'mp4', nameTemplate:'${BASENAME}-h265.mp4' }
    },{
        id:'h265-clip-scale', name:'H.265 均衡转码并缩放', description:'在均衡转码基础上按需截取片段和缩放；时间、尺寸与编码速度均可留空。', builtin:true,
        fields:[
            { name:'START_TIME', type:'duration', label:'开始时间', placeholder:'00:01:30' },
            { name:'END_TIME', type:'duration', label:'结束时间', placeholder:'00:03:15' },
            { name:'SCALE', type:'scale', label:'输出尺寸', placeholder:'1920:-2' },
            { name:'CRF', type:'number', label:'CRF', default:'28', min:0, max:51 },
            { name:'PRESET', type:'select', label:'编码速度', default:'', options:['','ultrafast','veryfast','fast','medium','slow','veryslow'] }
        ], rules:[],
        steps:[{ name:'截取并缩放', args:[
            {when:'START_TIME',values:['-ss','${START_TIME}']}, '-i','${INPUT_FILE}', {when:'END_TIME',values:['-to','${END_TIME}']},
            '-c:v','libx265',{when:'CRF',values:['-crf','${CRF}']},{when:'PRESET',values:['-preset','${PRESET}']},{when:'SCALE',values:['-vf','scale=${SCALE}']},'-movflags','+faststart','-c:a','copy','${OUTPUT_FILE}'
        ] }], output:{ extension:'mp4', nameTemplate:'${BASENAME}-scaled.mp4' }
    }];
}

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive:true });
    const temp=`${filePath}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(temp, JSON.stringify(value,null,2)); fs.renameSync(temp,filePath);
}
function cleanName(value, fallback='video') { return String(value||fallback).replace(/[\\/:*?"<>|\x00-\x1f]+/g,'-').slice(0,180)||fallback; }
function validateProfile(input) {
    const profile=JSON.parse(JSON.stringify(input||{}));
    profile.id=String(profile.id||'').trim(); profile.name=String(profile.name||'').trim();
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(profile.id)||!profile.name)throw new Error('INVALID_PROFILE_ID_OR_NAME');
    if(!Array.isArray(profile.fields)||!Array.isArray(profile.steps)||!profile.steps.length)throw new Error('INVALID_PROFILE_SCHEMA');
    const names=new Set();
    profile.fields=profile.fields.map(field=>{const name=String(field?.name||'').trim();if(!/^[A-Z][A-Z0-9_]{1,40}$/.test(name)||SYSTEM_FIELDS.has(name)||names.has(name)||!FIELD_TYPES.has(field.type))throw new Error(`INVALID_PROFILE_FIELD:${name}`);names.add(name);return{...field,name,label:String(field.label||name).slice(0,80),required:field.required===true,options:Array.isArray(field.options)?field.options.map(String).slice(0,50):undefined};});
    profile.rules=Array.isArray(profile.rules)?profile.rules.map(rule=>{if(rule?.type!=='requireAny'||!Array.isArray(rule.fields)||rule.fields.some(name=>!names.has(name)))throw new Error('INVALID_PROFILE_RULE');return{type:'requireAny',fields:rule.fields,message:String(rule.message||'请填写至少一个必填条件').slice(0,160)};}):[];
    const allowed=new Set([...names,...SYSTEM_FIELDS]);
    const checkToken=token=>{if(typeof token!=='string'||token.includes('\0')||token.length>2000)throw new Error('INVALID_PROFILE_ARGUMENT');for(const match of token.matchAll(/\$\{([A-Z0-9_]+)\}/g))if(!allowed.has(match[1]))throw new Error(`UNKNOWN_PROFILE_VARIABLE:${match[1]}`);};
    profile.steps=profile.steps.slice(0,10).map((step,index)=>{if(!Array.isArray(step?.args)||!step.args.length)throw new Error('INVALID_PROFILE_STEP');const args=step.args.map(item=>{if(typeof item==='string'){checkToken(item);return item;}if(!item||!names.has(item.when)||!Array.isArray(item.values)){throw new Error('INVALID_OPTIONAL_ARGUMENT');}item.values.forEach(checkToken);return{when:item.when,values:item.values};});const serialized=JSON.stringify(args);if(!serialized.includes('${OUTPUT_FILE}')||(!serialized.includes('${INPUT_FILE}')&&!serialized.includes('${ORIGINAL_INPUT_FILE}')))throw new Error('PROFILE_STEP_REQUIRES_INPUT_AND_OUTPUT');return{name:String(step.name||`步骤 ${index+1}`).slice(0,80),args};});
    const extension=String(profile.output?.extension||'mp4').toLowerCase();if(!OUTPUT_EXTENSIONS.has(extension))throw new Error('INVALID_OUTPUT_EXTENSION');
    profile.output={extension,nameTemplate:String(profile.output?.nameTemplate||'${BASENAME}-transcoded.${EXT}').slice(0,180)};profile.description=String(profile.description||'').slice(0,500);delete profile.builtin;return profile;
}
function validateParams(profile,input={}) {
    const values={};
    for(const field of profile.fields){let value=input[field.name];if(field.type==='boolean')value=value===true||value==='true'?'1':'';else value=String(value??field.default??'').trim();if(field.required&&!value)throw new Error(`FIELD_REQUIRED:${field.name}`);if(value){if(field.type==='number'&&(!Number.isFinite(Number(value))||(field.min!==undefined&&Number(value)<Number(field.min))||(field.max!==undefined&&Number(value)>Number(field.max))))throw new Error(`FIELD_INVALID:${field.name}`);if(field.type==='duration'&&!/^(?:\d+:)?[0-5]?\d:[0-5]\d(?:\.\d{1,3})?$|^\d+(?:\.\d+)?$/.test(value))throw new Error(`FIELD_INVALID:${field.name}`);if(field.type==='scale'&&!/^(?:-?\d+):(?:-?\d+)$/.test(value))throw new Error(`FIELD_INVALID:${field.name}`);if(field.type==='select'&&field.options&&!field.options.includes(value))throw new Error(`FIELD_INVALID:${field.name}`);}values[field.name]=value;}
    for(const rule of profile.rules||[])if(rule.type==='requireAny'&&!rule.fields.some(name=>values[name]))throw new Error(rule.message||'PROFILE_RULE_FAILED');return values;
}
function interpolate(token,values){return token.replace(/\$\{([A-Z0-9_]+)\}/g,(_,name)=>String(values[name]??''));}
function buildArgs(step,values){const args=[];for(const item of step.args){if(typeof item==='string')args.push(interpolate(item,values));else if(values[item.when])args.push(...item.values.map(token=>interpolate(token,values)));}return args;}

function createVideoTranscodeService({ dataDir, ffmpegCommand='ffmpeg', spawnProcess=spawn }={}) {
    const root=path.join(dataDir,'.video-transcode');
    const profileFile=path.join(dataDir,'video-transcode-profiles.json'), taskFile=path.join(dataDir,'video-transcode-tasks.json');
    fs.mkdirSync(root,{recursive:true});
    let customProfiles=[];try{customProfiles=JSON.parse(fs.readFileSync(profileFile,'utf8')).map(validateProfile);}catch(_){}
    let tasks=[];try{tasks=JSON.parse(fs.readFileSync(taskFile,'utf8'));}catch(_){}
    tasks.forEach(task=>{if(['uploading','queued','running'].includes(task.status)){task.status='failed';task.error='服务器重启，任务已中断';task.finishedAt=Date.now();}});
    const running=new Map(), queue=[];let consuming=false;
    const profiles=()=>[...defaultProfiles(),...customProfiles];
    const persistTasks=()=>atomicWrite(taskFile,tasks.slice(-300));
    const publicTask=task=>{const copy={...task};delete copy.inputPath;delete copy.outputPath;return copy;};
    function getTask(id){return tasks.find(task=>task.id===id);}
    function profile(id){return profiles().find(item=>item.id===id);}
    function saveProfile(input){const next=validateProfile(input);if(defaultProfiles().some(item=>item.id===next.id))throw new Error('BUILTIN_PROFILE_READ_ONLY');const index=customProfiles.findIndex(item=>item.id===next.id);if(index>=0)customProfiles[index]=next;else customProfiles.push(next);atomicWrite(profileFile,customProfiles);return next;}
    function deleteProfile(id){const before=customProfiles.length;customProfiles=customProfiles.filter(item=>item.id!==id);if(before===customProfiles.length)throw new Error('PROFILE_NOT_FOUND');atomicWrite(profileFile,customProfiles);}
    function createTask(input){const selected=profile(input.profileId);if(!selected)throw new Error('PROFILE_NOT_FOUND');const params=validateParams(selected,input.params);const id=crypto.randomUUID(),dir=path.join(root,id);fs.mkdirSync(dir,{recursive:true});const original=cleanName(input.fileName,'input.mp4');const inputPath=path.join(dir,`input-${original}`);const task={id,profileId:selected.id,profileName:selected.name,params,fileName:original,size:Math.max(0,Number(input.size)||0),type:String(input.type||''),status:'uploading',phase:'等待上传源文件',progress:null,createdAt:Date.now(),updatedAt:Date.now(),inputPath,outputPath:'',outputName:'',logs:[]};tasks.push(task);persistTasks();return publicTask(task);}
    async function receiveInput(id,req){const task=getTask(id);if(!task||task.status!=='uploading')throw Object.assign(new Error('TASK_NOT_UPLOADABLE'),{status:409});const declared=Number(req.headers['content-length']||0);if(task.size&&declared&&declared!==task.size)throw Object.assign(new Error('INPUT_SIZE_MISMATCH'),{status:400});const max=20*1024*1024*1024;if(declared>max)throw Object.assign(new Error('INPUT_TOO_LARGE'),{status:413});let received=0;await new Promise((resolve,reject)=>{const output=fs.createWriteStream(task.inputPath,{flags:'wx'});req.on('data',chunk=>{received+=chunk.length;if(received>max){req.destroy();output.destroy(new Error('INPUT_TOO_LARGE'));}});req.pipe(output);output.on('finish',resolve);output.on('error',reject);req.on('error',reject);});if(task.size&&received!==task.size){fs.rmSync(task.inputPath,{force:true});throw Object.assign(new Error('INPUT_SIZE_MISMATCH'),{status:400});}task.receivedBytes=received;task.phase='源文件已上传';task.updatedAt=Date.now();persistTasks();return publicTask(task);}
    async function createSourceTask(input,source){
        const stat=await fs.promises.stat(source.path);
        if(!stat.isFile()||!stat.size)throw Object.assign(new Error('SOURCE_FILE_NOT_FOUND'),{status:404});
        const created=createTask({...input,fileName:source.name,size:stat.size,type:source.type||'video/*'}),task=getTask(created.id);
        try{
            await fs.promises.link(source.path,task.inputPath).catch(error=>{
                if(['EXDEV','EPERM','EACCES','EMLINK','ENOTSUP'].includes(error.code))return fs.promises.copyFile(source.path,task.inputPath);
                throw error;
            });
            task.receivedBytes=stat.size;
            task.phase='已接入下载任务的服务器缓存';
            return startTask(task.id);
        }catch(error){removeTask(task.id);throw error;}
    }
    function startTask(id){const task=getTask(id);if(!task||task.status!=='uploading'||!fs.existsSync(task.inputPath))throw new Error('TASK_NOT_READY');task.status='queued';task.phase='等待转码';task.updatedAt=Date.now();queue.push(id);persistTasks();consume();return publicTask(task);}
    async function runTask(task){const selected=profile(task.profileId);if(!selected)throw new Error('PROFILE_NOT_FOUND');const base=path.parse(task.fileName).name,dir=path.dirname(task.inputPath);let currentInput=task.inputPath;
        task.status='running';task.startedAt=Date.now();
        for(let index=0;index<selected.steps.length;index++){if(task.cancelRequested)throw new Error('TASK_CANCELLED');const final=index===selected.steps.length-1;const ext=final?selected.output.extension:'mkv';const output=path.join(dir,final?`output.${ext}`:`step-${index+1}.${ext}`);const values={...task.params,INPUT_FILE:currentInput,ORIGINAL_INPUT_FILE:task.inputPath,OUTPUT_FILE:output,BASENAME:base,EXT:ext};const args=['-y',...buildArgs(selected.steps[index],values)];task.phase=`${index+1}/${selected.steps.length} ${selected.steps[index].name}`;task.progress=Math.round(index/selected.steps.length*100);task.updatedAt=Date.now();persistTasks();await new Promise((resolve,reject)=>{const child=spawnProcess(ffmpegCommand,args,{shell:false,windowsHide:true,stdio:['ignore','ignore','pipe']});running.set(task.id,child);let pending='';child.stderr?.on('data',chunk=>{pending+=chunk.toString();const lines=pending.split(/\r?\n/);pending=lines.pop()||'';task.logs.push(...lines.filter(Boolean).slice(-20));task.logs=task.logs.slice(-80);task.updatedAt=Date.now();});child.on('error',reject);child.on('exit',(code,signal)=>{running.delete(task.id);if(task.cancelRequested||signal)return reject(new Error('TASK_CANCELLED'));if(code!==0)return reject(new Error(`FFMPEG_EXIT_${code}`));resolve();});});if(!fs.existsSync(output))throw new Error('FFMPEG_OUTPUT_NOT_CREATED');if(currentInput!==task.inputPath)fs.rmSync(currentInput,{force:true});currentInput=output;}
        task.outputPath=currentInput;task.outputName=cleanName(selected.output.nameTemplate.replace(/\$\{BASENAME\}/g,base).replace(/\$\{EXT\}/g,selected.output.extension),`${base}-transcoded.${selected.output.extension}`);task.status='completed';task.phase='已完成';task.progress=100;task.finishedAt=Date.now();task.updatedAt=Date.now();persistTasks();}
    async function consume(){if(consuming)return;consuming=true;while(queue.length){const task=getTask(queue.shift());if(!task||task.status!=='queued')continue;try{await runTask(task);}catch(error){task.status=task.cancelRequested?'cancelled':'failed';task.phase=task.cancelRequested?'已取消':'转码失败';task.error=error.message;task.finishedAt=Date.now();task.updatedAt=Date.now();persistTasks();}}consuming=false;}
    function cancel(id){const task=getTask(id);if(!task||!['uploading','queued','running'].includes(task.status))throw new Error('TASK_NOT_CANCELLABLE');task.cancelRequested=true;running.get(id)?.kill('SIGTERM');if(task.status!=='running'){task.status='cancelled';task.phase='已取消';task.finishedAt=Date.now();}task.updatedAt=Date.now();persistTasks();return publicTask(task);}
    function removeTask(id){const index=tasks.findIndex(task=>task.id===id);if(index<0)throw new Error('TASK_NOT_FOUND');if(['queued','running'].includes(tasks[index].status))throw new Error('TASK_IS_ACTIVE');const [task]=tasks.splice(index,1);fs.rmSync(path.join(root,id),{recursive:true,force:true});persistTasks();return publicTask(task);}
    const directorySize=directory=>{let total=0;if(!fs.existsSync(directory))return 0;for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const target=path.join(directory,entry.name);try{if(entry.isDirectory())total+=directorySize(target);else total+=fs.statSync(target).size;}catch(_){}}return total;};
    function cacheStats(){const activeIds=new Set(tasks.filter(task=>['uploading','queued','running'].includes(task.status)).map(task=>task.id)),knownIds=new Set(tasks.map(task=>task.id));let activeBytes=0,finishedBytes=0,orphanBytes=0;for(const entry of fs.readdirSync(root,{withFileTypes:true})){if(!entry.isDirectory())continue;const size=directorySize(path.join(root,entry.name));if(activeIds.has(entry.name))activeBytes+=size;else if(knownIds.has(entry.name))finishedBytes+=size;else orphanBytes+=size;}return{root,totalBytes:activeBytes+finishedBytes+orphanBytes,activeBytes,finishedBytes,orphanBytes};}
    function cleanupCache(scope='residual') {if(!['residual','finished'].includes(scope))throw new Error('INVALID_CACHE_CLEANUP_SCOPE');const activeIds=new Set(tasks.filter(task=>['uploading','queued','running'].includes(task.status)).map(task=>task.id)),known=new Map(tasks.map(task=>[task.id,task]));let removedBytes=0,removedEntries=0;for(const entry of fs.readdirSync(root,{withFileTypes:true})){if(!entry.isDirectory()||activeIds.has(entry.name))continue;const task=known.get(entry.name),removeEntry=!task||(scope==='finished'&&['completed','failed','cancelled'].includes(task.status))||(scope==='residual'&&['failed','cancelled'].includes(task?.status));if(!removeEntry)continue;const target=path.join(root,entry.name);removedBytes+=directorySize(target);fs.rmSync(target,{recursive:true,force:true});removedEntries++;if(task){task.cacheCleared=true;task.cacheClearedAt=Date.now();task.outputPath='';task.inputPath='';if(task.status==='completed')task.phase='已完成（结果缓存已清理）';}}if(removedEntries)persistTasks();return{scope,removedBytes,removedEntries,stats:cacheStats()};}
    return { profiles,saveProfile,deleteProfile,createTask,createSourceTask,receiveInput,startTask,cancel,removeTask,cacheStats,cleanupCache,getTask,listTasks:()=>tasks.slice().reverse().map(publicTask),publicTask };
}

function registerVideoTranscodeRoutes(app,{service,requireAuth,resolveSource}){
    const fail=(res,error)=>res.status(Number(error.status)||(/NOT_FOUND/.test(error.message)?404:/NOT_|INVALID|REQUIRED|MISMATCH|RULE/.test(error.message)?400:500)).json({error:error.message});
    app.get('/api/video-transcode/profiles',requireAuth,(req,res)=>res.json({profiles:service.profiles()}));
    app.post('/api/video-transcode/profiles',requireAuth,(req,res)=>{try{res.json({profile:service.saveProfile(req.body)});}catch(error){fail(res,error);}});
    app.delete('/api/video-transcode/profiles/:id',requireAuth,(req,res)=>{try{service.deleteProfile(req.params.id);res.json({ok:true});}catch(error){fail(res,error);}});
    app.get('/api/video-transcode/tasks',requireAuth,(req,res)=>res.json({tasks:service.listTasks()}));
    app.get('/api/video-transcode/cache',requireAuth,(req,res)=>res.json(service.cacheStats()));
    app.post('/api/video-transcode/cache/cleanup',requireAuth,(req,res)=>{try{res.json(service.cleanupCache(req.body?.scope||'residual'));}catch(error){fail(res,error);}});
    app.post('/api/video-transcode/tasks',requireAuth,(req,res)=>{try{res.status(201).json({task:service.createTask(req.body)});}catch(error){fail(res,error);}});
    app.get('/api/video-transcode/sources/:kind/:taskId',requireAuth,(req,res)=>{try{const source=resolveSource?.(req.params.kind,req.params.taskId);if(!source)throw Object.assign(new Error('SOURCE_FILE_NOT_FOUND'),{status:404});res.json({name:source.name,size:fs.statSync(source.path).size,type:source.type||'video/*'});}catch(error){fail(res,error);}});
    app.post('/api/video-transcode/source-tasks',requireAuth,async(req,res)=>{try{const source=resolveSource?.(req.body?.sourceKind,req.body?.sourceTaskId);if(!source)throw Object.assign(new Error('SOURCE_FILE_NOT_FOUND'),{status:404});res.status(201).json({task:await service.createSourceTask(req.body,source)});}catch(error){fail(res,error);}});
    app.put('/api/video-transcode/tasks/:id/input',requireAuth,async(req,res)=>{try{res.json({task:await service.receiveInput(req.params.id,req)});}catch(error){fail(res,error);}});
    app.post('/api/video-transcode/tasks/:id/start',requireAuth,(req,res)=>{try{res.json({task:service.startTask(req.params.id)});}catch(error){fail(res,error);}});
    app.post('/api/video-transcode/tasks/:id/cancel',requireAuth,(req,res)=>{try{res.json({task:service.cancel(req.params.id)});}catch(error){fail(res,error);}});
    app.delete('/api/video-transcode/tasks/:id',requireAuth,(req,res)=>{try{res.json({task:service.removeTask(req.params.id)});}catch(error){fail(res,error);}});
    app.get('/api/video-transcode/tasks/:id/download',requireAuth,(req,res)=>{const task=service.getTask(req.params.id);if(!task||task.status!=='completed'||!fs.existsSync(task.outputPath))return res.status(404).json({error:'OUTPUT_NOT_FOUND'});res.download(task.outputPath,task.outputName);});
}

module.exports={createVideoTranscodeService,registerVideoTranscodeRoutes,validateProfile,validateParams,buildArgs,defaultProfiles};
