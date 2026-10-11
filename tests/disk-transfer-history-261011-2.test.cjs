'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createFixture}=require('./support/disk-content-admin-fixture.cjs');
const {createDiskOperations}=require('../server/disk-operations');
const {openDiskRepository}=require('../server/disk-repository');
const {namespaceName}=require('../server/disk-transfer-history');

async function fixture(t){
    const f=await createFixture();t.after(()=>f.close());
    const call=async(route,body,user='alice',method=body?'POST':'GET')=>{
        const response=await fetch(f.base+'/api/telegram/drive'+route,{method,headers:{'X-Test-User':user,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
        const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;
    };
    return {f,call,drive:f.api.spaces.get('')};
}
const histories=data=>data.operations.filter(job=>job.type==='transfer-history');

test('普通复制明细记录真实分区显示名称与路径；来源分区显示，目标分区不显示',async t=>{
    const {f,call}=await fixture(t),spaces=(await call('/spaces')).spaces,source=spaces.find(s=>s.isDefault);
    const {partition:target}=await call('/spaces',{name:'中文目标分区'});
    const input={mode:'copy',targetSpace:target.id,requestId:'native-copy-origin-test',items:[{kind:'file',id:'file-a'}]};
    await call('/spaces/transfer',input);
    const [job]=histories(await call('/operations'));
    assert.equal(job.transferDetails.source.name,'默认分区');assert.equal(job.transferDetails.target.name,'中文目标分区');
    assert.equal(job.transferDetails.source.entries[0].path,'/资料/同名/相同.har');assert.equal(job.transferDetails.target.directory,'/');
    assert.equal(job.historyOrigin.partitionId,source.id);assert.equal(histories(await call('/operations?disk_space='+target.scopeKey)).length,0);
    await call('/spaces/'+target.id,{name:'后来改名'},'alice','PATCH');
    assert.equal(histories(await call('/operations'))[0].transferDetails.target.name,'中文目标分区');
    assert.equal(f.api.spaces.get(target.scopeKey).list('alice','').files.length,1);
});

test('从其它原生分区发起的复制记录跟随实际源分区，幂等重试不重新复制',async t=>{
    const {f,call}=await fixture(t),spaces=(await call('/spaces')).spaces,photo=spaces.find(s=>s.scopeKey==='相册&照片');
    f.api.spaces.get(photo.scopeKey).createDirectory('alice','日本語 & 测试/留档',30);
    f.api.spaces.get('').createDirectory('bob','backup/目标',30);
    const invitation=await call('/collaborations/invitations',{kind:'directory',path:'backup'},'bob');await call('/collaborations/join',{token:invitation.url.split('/').at(-1)});
    const input={mode:'copy',requestId:'different-view-source-test',source:{kind:'native',partitionId:photo.id,selection:{kind:'file',id:'file-photo'}},target:{kind:'collaboration',collaborationId:invitation.collaboration.id,destinationPath:'backup/目标'}};
    const first=await call('/cross-scope/copy',input),again=await call('/cross-scope/copy',input);
    assert.deepEqual(again,first);assert.equal(histories(await call('/operations')).length,0);
    const jobs=histories(await call('/operations?disk_space='+encodeURIComponent(photo.scopeKey)));assert.equal(jobs.length,1);
    assert.equal(jobs[0].diskSpace,photo.scopeKey);assert.equal(jobs[0].transferDetails.source.name,photo.name);
    assert.equal(f.api.spaces.get('').list('bob','backup/目标').files.length,1);
});

test('协同源任务只在源 grant 显示；换本地挂载分区不丢失，不泄露给来源所有者',async t=>{
    const {call,drive}=await fixture(t);drive.createDirectory('bob','backup/内部',30);drive.createDirectory('bob','其它项目',30);drive.createDirectory('alice','收件',30);
    const invitation=await call('/collaborations/invitations',{kind:'directory',path:'backup'},'bob');
    await call('/collaborations/join',{token:invitation.url.split('/').at(-1)});
    const unrelated=await call('/collaborations/invitations',{kind:'directory',path:'其它项目'},'bob');
    await call('/collaborations/join',{token:unrelated.url.split('/').at(-1)});
    const {mount}=await call('/mounts',{parentPath:'',name:'源挂载',collaborationId:invitation.collaboration.id});
    const {partition}=await call('/spaces',{name:'另一个本地分区'});
    const {mount:otherMount}=await call('/mounts?disk_space='+partition.scopeKey,{parentPath:'',name:'另一入口',collaborationId:invitation.collaboration.id});
    const input={mode:'copy',requestId:'collaboration-source-history',source:{kind:'collaboration',collaborationId:invitation.collaboration.id,selection:{kind:'file',id:'file-b'}},target:{kind:'native',destinationPath:'收件'}};
    await call('/cross-scope/copy',input);
    assert.equal(histories(await call('/operations')).length,0);assert.equal(histories(await call('/operations?disk_space='+partition.scopeKey)).length,0);
    const [job]=histories(await call('/mount-scope/'+mount.id+'/operations'));
    assert.equal(job.transferDetails.source.name,'backup');assert.equal(job.transferDetails.target.name,'默认分区');assert.equal(job.transferDetails.source.entries[0].path,'/相同.har');
    assert.equal(histories(await call('/mount-scope/'+otherMount.id+'/operations?disk_space='+partition.scopeKey))[0].operation_id,job.operation_id);
    assert.equal(histories(await call('/collaboration-scope/'+unrelated.collaboration.id+'/operations')).length,0);
    assert.equal(histories(await call('/operations',null,'bob')).length,0);
    const detail=await call('/mount-scope/'+otherMount.id+'/operations/'+job.operation_id+'?disk_space='+partition.scopeKey);assert.equal(detail.operation_id,job.operation_id);
    const moved=await call('/mount-scope/'+mount.id+'/files/file-b',{folderPath:'backup/内部',requestId:'mounted-file-origin-history'},'alice','PATCH');
    for(let i=0;i<100;i++){const op=await call('/mount-scope/'+mount.id+'/operations/'+moved.operation_id);if(op.status==='completed')break;assert.notEqual(op.status,'failed');await new Promise(r=>setTimeout(r,10));}
    const ownerJobs=(await call('/operations',null,'bob')).operations;assert.ok(!ownerJobs.some(op=>op.operation_id===moved.operation_id));
    const scoped=(await call('/mount-scope/'+mount.id+'/operations')).operations;assert.ok(scoped.some(op=>op.requestId==='mounted-file-origin-history'&&op.status==='completed'));
});

test('旧历史名称缺失使用明确占位；旧存错分区的明细按存下的来源ID定位',t=>{
    const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'history-origin-')),operations=createDiskOperations({dataDir}),repository=openDiskRepository(dataDir);
    t.after(()=>{operations.flush();repository.close();fs.rmSync(dataDir,{recursive:true,force:true});});
    const job=operations.create({userId:'alice',diskSpace:'旧发起分区'},'transfer-history','复制明细');
    operations.update(job.operation_id,{transferDetails:{mode:'copy',source:{kind:'native',id:'源分区ID',entries:[]},target:{kind:'native',id:'目标ID'}}},true);operations.complete(job.operation_id,{ok:true});
    assert.equal(operations.listHistory({userId:'alice',diskSpace:'源分区scope',partitionId:'源分区ID'})[0].operation_id,job.operation_id);
    assert.equal(operations.listHistory({userId:'alice',diskSpace:'旧发起分区',partitionId:'无关分区ID'}).length,0);
    assert.equal(operations.listHistory({userId:'bob',partitionId:'源分区ID'}).length,0);
    assert.equal(namespaceName({kind:'native',name:'undefined'}),'网盘分区（历史名称未记录）');assert.equal(namespaceName({kind:'collaboration'}),'协同项目（历史名称未记录）');
    assert.equal(namespaceName({displayName:'已保存名称'}),'已保存名称');
});

test('客户端后台轮询其它来源只结算原等待任务，不把它显示到当前任务列表',async()=>{
    const seen=[],calls=[],responses=new Map();let client;
    const waiting={operation_id:'pending-other-source',type:'move-file',status:'running',message:'正在移动',updatedAt:1};
    responses.set('',[waiting]);responses.set('另一个分区',[]);
    const window={};const sandbox={window,location:{origin:'http://fixture.test'},URL,fetch:async url=>{
        const parsed=new URL(url,'http://fixture.test'),space=parsed.searchParams.get('disk_space')||'';calls.push(space);
        return {ok:true,json:async()=>({operations:responses.get(space)||[]})};
    },localStorage:{getItem(){return null;},setItem(){}},setInterval(){},setTimeout,clearTimeout,AbortController};
    vm.runInNewContext(fs.readFileSync('client/disk-client.js','utf8'),sandbox);client=window.DiskClient;client.subscribe(jobs=>seen.push(Array.from(jobs,job=>job.operation_id)));
    client.start();await client.refresh(true);assert.deepEqual(seen.at(-1),['pending-other-source']);
    const pending=client.wait(waiting.operation_id,{requestBase:'/api/telegram/drive',diskSpace:''});
    client.setSpace('另一个分区');await new Promise(r=>setImmediate(r));await client.refresh(true);
    assert.deepEqual(seen.at(-1),[]);assert.ok(calls.includes('')&&calls.includes('另一个分区'));
    responses.set('',[{...waiting,status:'completed',updatedAt:2,result:{ok:true}}]);await client.refresh(true);
    assert.equal((await pending).ok,true);assert.deepEqual(seen.at(-1),[]);client.stop();
});

test('切到其它分区后，后台上传 SSE 失败仍及时中止正文请求并保留真实原因', {timeout:3000},async()=>{
    const window={},seen=[],requests=[],xhrs=[],streams=[];let failed=false;
    class XHR {constructor(){this.events={};this.upload={addEventListener(){}};}addEventListener(name,fn){this.events[name]=fn;}open(){}setRequestHeader(){}send(){xhrs.push(this);}abort(){this.aborted=true;this.events.abort?.();}}
    class EventSource {constructor(){this.events={};streams.push(this);}addEventListener(name,fn){this.events[name]=fn;}close(){this.closed=true;}}
    const operation=()=>({operation_id:'upload-source',type:'upload',status:failed?'failed':'running',errorCode:failed?'ECONNRESET':''});
    const fetch=async(url,options={})=>{const parsed=new URL(url,'http://fixture.test');requests.push({path:parsed.pathname,options});let data={};
        if(parsed.pathname.endsWith('/uploads'))data={uploadId:'upload',operation_id:'upload-source',progressive:true};
        else if(parsed.pathname.endsWith('/operations'))data={operations:parsed.searchParams.get('disk_space')?[]:[operation()]};
        else if(parsed.pathname.endsWith('/operations/upload-source'))data=operation();
        return {ok:true,json:async()=>data};
    };
    vm.runInNewContext(fs.readFileSync('client/disk-client.js','utf8'),{window,fetch,location:{origin:'http://fixture.test'},URL,XMLHttpRequest:XHR,EventSource,AbortController,setInterval(){},setTimeout,clearTimeout});
    const client=window.DiskClient;client.subscribe(jobs=>seen.push(Array.from(jobs,job=>job.operation_id)));
    const upload=client.upload([{name:'body.bin',size:100}],'',async()=>({size:100,slice:()=>({size:100})}));const rejected=assert.rejects(upload,/ECONNRESET/);
    for(let i=0;i<100&&(!xhrs.length||!streams.length);i++)await new Promise(r=>setImmediate(r));assert.equal(xhrs.length,1);
    client.setSpace('目标分区');await new Promise(r=>setImmediate(r));await client.refresh(true);assert.deepEqual(seen.at(-1),[]);
    failed=true;streams[0].events.progress({data:JSON.stringify(operation())});await rejected;
    assert.equal(xhrs[0].aborted,true);assert.equal(streams[0].closed,true);assert.deepEqual(seen.at(-1),[]);
    assert.ok(!requests.some(request=>request.options.method==='DELETE'));client.stop();
});
