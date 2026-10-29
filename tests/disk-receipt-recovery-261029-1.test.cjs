'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {createFixture}=require('./support/pending-save-261012-fixture.cjs');
function database(){
    const values=new Map();let tail=Promise.resolve();
    return {open(){const request={};queueMicrotask(()=>{
        request.result={createObjectStore(){},transaction(_key,mode){
            let pending=0,timer,working,release;const previous=tail;tail=new Promise(done=>{release=done;});
            const tx={objectStore:()=>({get:id=>read(()=>working.get(id)),getAll:()=>read(()=>[...working.values()]),put:value=>read(()=>working.set(value.id,structuredClone(value)))})};
            function read(fn){const item={};pending++;clearImmediate(timer);previous.then(()=>{working ||= new Map(values);item.result=structuredClone(fn());item.onsuccess?.();if(!--pending)timer=setImmediate(()=>{if(mode==='readwrite'){values.clear();for(const pair of working)values.set(...pair);}tx.oncomplete?.();release();});});return item;}
            return tx;
        }};request.onupgradeneeded?.();request.onsuccess?.();
    });return request;}};
}
test('completed task survives a fresh browser database and is recovered by exact server publication, without another upload',async t=>{
    const f=await createFixture({serverTransfers:true,adminAuthorized:req=>req.get('X-Test-Admin')==='fixture-admin'});t.after(()=>f.close());
    const login=await fetch(f.base+'/fixture-login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'id=alice'});
    const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    const send=(route,body,authorized=true)=>fetch(f.base+route,{method:body?'POST':'GET',headers:{Cookie:cookie,'Content-Type':'application/json',...(authorized?{'X-Test-Admin':'fixture-admin'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const task=await (await send('/api/sns-dl/tasks/sns-fixture')).json(),version=task.completedAt+'-'+task.outputFileSize;
    const spaces=await (await send('/api/telegram/drive/spaces')).json(),partition=spaces.spaces[0];
    const pendingId=crypto.randomUUID(),body={pendingSaveId:pendingId,source:'sns',taskId:task.id,version,partitionId:partition.id,folderPath:'甲目录'};
    const started=await (await send('/api/telegram/drive/task-saves',body)).json();assert.ok(started.operation_id,JSON.stringify(started));
    let completed;for(let n=0;n<100;n++){
        completed=await (await send('/api/telegram/drive/operations/'+started.operation_id)).json();
        if(completed.status==='completed')break;assert.ok(['queued','running'].includes(completed.status),JSON.stringify(completed));await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(completed.status,'completed');const file=completed.result.items[0];
    const input={tasks:[{source:'sns',taskId:task.id,version}]};
    assert.equal((await send('/api/telegram/disk-admin/task-save-receipts/lookup',input,false)).status,401);
    const source=fs.readFileSync('client/disk-pending-save.js','utf8');
    function fresh(){const calls=[];const context={URL,URLSearchParams,crypto:crypto.webcrypto,indexedDB:database(),setTimeout,clearTimeout,AbortController,
        fetch:async(route,options={})=>{calls.push(route);return fetch(f.base+route,{...options,headers:{...options.headers,Cookie:cookie,'X-Test-Admin':'fixture-admin'}});}};
        context.window=context;vm.runInNewContext(source,context);return {api:context.DiskPendingSave,calls};}
    const restored=fresh(),status=await restored.api.taskStatus({source:'sns',task});
    assert.equal(status.state,'saved');assert.equal(status.record.status,'completed');assert.equal(status.record.id,pendingId);
    assert.equal(status.record.target.accountId,'alice');assert.equal(status.record.target.path,'甲目录');assert.equal(status.record.target.partitionId,partition.id);assert.equal(status.record.result.items[0].id,file.id);
    assert.equal((await restored.api.prepareServer({source:'sns',task})).id,pendingId);
    f.tasks[0].hasFile=false;
    assert.equal((await fresh().api.prepareServer({source:'sns',task})).status,'completed','removing only the downloaded source must not hide the saved disk file');
    f.tasks[0].hasFile=true;
    const button={isConnected:true};restored.api.decorateButton(button,{source:'sns',task});
    for(let n=0;n<30&&button.textContent!=='已转存到网盘';n++)await new Promise(setImmediate);
    assert.equal(button.textContent,'已转存到网盘');assert.match(button.title,/验收甲账号.*甲目录/);
    const otherVersion=await (await send('/api/telegram/disk-admin/task-save-receipts/lookup',{tasks:[{source:'sns',taskId:task.id,version:'1000-'+task.outputFileSize},{source:'youtube',taskId:task.id,version}]})).json();
    assert.ok(otherVersion.results.every(item=>item.record===null));
    // A new store instance reads the persistent publication journal, independent
    // of browser state and of the API instance's in-memory receipt objects.
    const journal=require('../server/disk-pending-saves').createDiskPendingSaves(f.repository);
    assert.equal(journal.get('alice',pendingId).state,'completed');
    assert.equal(journal.get('alice',pendingId).taskSource.taskId,task.id);
    f.api.spaces.get('').moveFile('alice',file.id,'甲目录/子目录',30);
    assert.equal((await fresh().api.taskStatus({source:'sns',task})).state,'new');
    f.api.spaces.get('').remove('alice',file.id);
    assert.equal((await fresh().api.prepareServer({source:'sns',task})).status,'pending');
    const stats=await (await send('/fixture-stats')).json();assert.equal(stats.serverTransfersStarted,1);assert.equal(stats.browserUploads,0);
});

test('successful pending navigation removes temporary feedback and consumes only its completed link',()=>{
    const source=fs.readFileSync('client/disk-ui.js','utf8'),start=source.indexOf('function finishPendingSaveFeedback('),end=source.indexOf('async function pendingSaveRead(',start);
    const url='http://localhost/disk?pendingSave=completed-record&disk_account=alice&disk_path=a&keep=yes#keep',calls=[];
    const context={URL,document:{getElementById:id=>({remove:()=>calls.push(id)})},location:{href:url},history:{state:{telegramDriveOpen:true},replaceState:(...args)=>calls.push(args)},telegramDrivePendingSaveId:'completed-record',telegramDriveEntryQuery:new URL(url).searchParams};
    vm.runInNewContext(source.slice(start,end)+';finishPendingSaveFeedback("completed-record");',context);
    assert.equal(context.telegramDrivePendingSaveId,'');assert.equal(context.telegramDriveEntryQuery.has('pendingSave'),false);
    assert.equal(calls[0],'diskPendingSaveFeedback');assert.equal(calls[1][2],'http://localhost/disk?keep=yes#keep');
    calls.length=0;context.telegramDrivePendingSaveId='newer-record';
    vm.runInNewContext(source.slice(start,end)+';finishPendingSaveFeedback("completed-record");',context);
    assert.equal(context.telegramDrivePendingSaveId,'newer-record');assert.equal(calls.length,0,'a late old completion cannot clear the newer flow or its navigation');
});
