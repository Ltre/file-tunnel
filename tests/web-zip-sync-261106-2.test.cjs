'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createWebZipSync}=require('../server/web-zip-sync');
const clone=value=>JSON.parse(JSON.stringify(value));
async function waitUntil(predicate){for(let n=0;n<100;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.ok(predicate(),'webpage synchronization did not settle');}
function setup(t){
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'web-zip-sync-261106-'));
    t.after(()=>{assert.ok(directory.startsWith(path.join(os.tmpdir(),'web-zip-sync-261106-')));fs.rmSync(directory,{recursive:true,force:true});});
    const filename=path.join(directory,'jobs.json'),records=new Map(),writes=[],logs=[];
    const file={id:'original-file',name:'page.html.zip',type:'application/zip',size:3,creatorDeviceId:'creator',creatorDeviceName:'Creator',webZipDraftId:'draft',webZipEditors:['editor'],ownerDeviceId:'creator'};
    records.set('A:origin',{id:'origin',type:'file',sender:'creator',timestamp:10,remark:'source remark',fileInfo:clone(file)});
    records.set('B:copy',{id:'copy',type:'file',sender:'editor',timestamp:20,remark:'copy remark',forwardedFrom:{sessionId:'A',messageId:'origin'},fileInfo:{...clone(file),id:'copy-file',ownerDeviceId:'editor'}});
    const state={available:false,allowed:true,content:true,trusted:true,gate:null},readRecord=(s,id)=>records.get(s+':'+id)||null;
    const dependencies={filename,readRecord,
        writeRecord:async(s,previous,next,options={})=>{
            if(s==='A'&&state.gate)await state.gate;
            if(JSON.stringify(readRecord(s,previous.id))!==JSON.stringify(previous)||options.check?.()===false)throw Error('WEB_ZIP_SOURCE_CHANGED');
            records.set(s+':'+previous.id,clone(next));writes.push({sessionId:s,previous:clone(previous),next:clone(next),options});return readRecord(s,previous.id);
        },canPublish:()=>state.allowed,hasContent:()=>state.content,canSync:()=>state.available,isForwardedCopy:()=>state.trusted,log:(...args)=>logs.push(args)};
    let service=createWebZipSync(dependencies);
    const input=(id='new-file',fileId=readRecord('B','copy').fileInfo.id)=>({sessionId:'B',messageId:'copy',fileId,deviceId:'editor',fileInfo:{id,name:'updated.html.zip',type:'application/zip',size:5}});
    return{state,records,writes,logs,filename,read:readRecord,input,get service(){return service;},restart:()=>service=createWebZipSync(dependencies)};
}
test('publishing a forwarded webpage keeps a durable pending marker and never changes the unavailable source',async t=>{
    const f=setup(t),saved=await f.service.publish(f.input());
    assert.equal(saved.fileInfo.id,'new-file');assert.equal(saved.fileInfo.webZipPendingSync.state,'pending');assert.equal(f.read('A','origin').fileInfo.id,'original-file');
    assert.deepEqual(f.writes.map(value=>value.sessionId),['B']);assert.equal(JSON.parse(fs.readFileSync(f.filename)).jobs.length,1);
    assert.equal(saved.sender,'editor');assert.equal(saved.remark,'copy remark');assert.equal(saved.fileInfo.webZipRootId,'original-file');
});
test('a permitted path resumes the exact source anchor, preserves unrelated data and clears the pending marker',async t=>{
    const f=setup(t);await f.service.publish(f.input());f.state.available=true;
    for(let i=0;i<8;i++)f.service.topologyChanged();await waitUntil(()=>!f.read('B','copy').fileInfo.webZipPendingSync);
    const original=f.read('A','origin');assert.equal(original.fileInfo.id,'new-file');assert.equal(original.id,'origin');assert.equal(original.sender,'creator');assert.equal(original.timestamp,10);assert.equal(original.remark,'source remark');
    assert.equal(original.fileInfo.backupSourceSessionId,'B');assert.equal(original.fileInfo.forwardedToSessionId,'A');
    assert.equal(f.writes.filter(value=>value.sessionId==='A').length,1);assert.equal(f.writes.find(value=>value.sessionId==='A').options.copyFromSessionId,'B');
    await waitUntil(()=>JSON.parse(fs.readFileSync(f.filename)).jobs.length===0);
});
test('pending work survives restart; repeated publish acknowledgements do not create new versions',async t=>{
    const f=setup(t),payload=f.input();await f.service.publish(payload);const count=f.writes.length;await f.service.publish(payload);assert.equal(f.writes.length,count);
    f.restart();f.state.available=true;f.service.topologyChanged();await waitUntil(()=>!f.read('B','copy').fileInfo.webZipPendingSync);assert.equal(f.read('A','origin').fileInfo.id,'new-file');
});
test('only the latest unsynchronized publication is applied after a path becomes available',async t=>{
    const f=setup(t);await f.service.publish(f.input('first'));await f.service.publish(f.input('latest'));
    f.state.available=true;f.service.topologyChanged();await waitUntil(()=>!f.read('B','copy').fileInfo.webZipPendingSync);
    assert.equal(f.read('A','origin').fileInfo.id,'latest');assert.equal(f.read('A','origin').fileInfo.webZipRevision,2);assert.equal(f.writes.filter(value=>value.sessionId==='A').length,1);
});
test('a source that changed independently is marked and never overwritten',async t=>{
    const f=setup(t);await f.service.publish(f.input());Object.assign(f.read('A','origin').fileInfo,{id:'independent',webZipRootId:'original-file',webZipRevision:1});
    f.state.available=true;f.service.topologyChanged();await waitUntil(()=>f.read('B','copy').fileInfo.webZipPendingSync.lastError==='WEB_ZIP_SOURCE_CHANGED');
    assert.equal(f.read('A','origin').fileInfo.id,'independent');assert.equal(f.writes.filter(value=>value.sessionId==='A').length,0);
});
test('a newer publication supersedes a waiting source write without another topology event',async t=>{
    const f=setup(t);await f.service.publish(f.input('first'));let release;f.state.gate=new Promise(resolve=>release=resolve);f.state.available=true;f.service.topologyChanged();
    await new Promise(resolve=>setTimeout(resolve,20));const newer=f.service.publish(f.input('latest'));await new Promise(resolve=>setTimeout(resolve,20));release();await newer;
    await waitUntil(()=>!f.read('B','copy').fileInfo.webZipPendingSync);assert.equal(f.read('A','origin').fileInfo.id,'latest');assert.equal(f.writes.filter(value=>value.sessionId==='A').length,1);
});
test('deleted source records are not recreated; deleting the forwarded record drops its pending work',async t=>{
    const f=setup(t);await f.service.publish(f.input());f.records.delete('A:origin');f.state.available=true;f.service.topologyChanged();
    await waitUntil(()=>f.read('B','copy').fileInfo.webZipPendingSync.lastError==='WEB_ZIP_SOURCE_MISSING');assert.equal(f.read('A','origin'),null);
    f.records.delete('B:copy');f.service.topologyChanged();await waitUntil(()=>JSON.parse(fs.readFileSync(f.filename)).jobs.length===0);assert.equal(f.read('A','origin'),null);
});
test('source permission is checked and an explicit creator approval covers the linked source',async t=>{
    const f=setup(t);f.read('A','origin').fileInfo.webZipEditors=[];await f.service.publish(f.input());f.state.available=true;f.service.topologyChanged();
    await waitUntil(()=>f.read('B','copy').fileInfo.webZipPendingSync.lastError==='WEB_ZIP_SOURCE_EDIT_DENIED');
    assert.equal(f.service.needsApproval('B','copy','new-file','editor'),true);
    await assert.rejects(f.service.approve({sessionId:'B',messageId:'copy',fileId:'new-file',creatorDeviceId:'outsider',deviceId:'editor'}),/not-web-zip-creator/);
    await f.service.approve({sessionId:'B',messageId:'copy',fileId:'new-file',creatorDeviceId:'creator',deviceId:'editor'});
    await waitUntil(()=>!f.read('B','copy').fileInfo.webZipPendingSync);assert.equal(f.read('A','origin').fileInfo.id,'new-file');
});
test('legacy copy roots converge on the original root and a queued creator approval survives a file version replacement',async t=>{
    const f=setup(t);f.read('B','copy').fileInfo.webZipRootId='copy-file';await f.service.publish(f.input());
    assert.equal(f.read('B','copy').fileInfo.webZipRootId,'original-file');
    await f.service.approve({sessionId:'B',messageId:'copy',fileId:'copy-file',creatorDeviceId:'creator',deviceId:'later-editor'});
    assert.ok(f.read('B','copy').fileInfo.webZipEditors.includes('later-editor'));assert.ok(f.read('A','origin').fileInfo.webZipEditors.includes('later-editor'));
});
test('confirmed deletion cancels pending work without a future visibility event',async t=>{
    const f=setup(t);await f.service.publish(f.input());f.records.delete('B:copy');f.service.recordChanged('B','copy');await waitUntil(()=>JSON.parse(fs.readFileSync(f.filename)).jobs.length===0);assert.equal(f.read('A','origin').fileInfo.id,'original-file');
});
test('losing the eligible device while the source write waits keeps the work pending',async t=>{
    const f=setup(t);await f.service.publish(f.input());let release;f.state.gate=new Promise(resolve=>release=resolve);f.state.available=true;f.service.topologyChanged();
    await new Promise(resolve=>setTimeout(resolve,20));f.state.available=false;release();await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(f.read('A','origin').fileInfo.id,'original-file');assert.ok(f.read('B','copy').fileInfo.webZipPendingSync);
    f.state.gate=null;f.state.available=true;f.service.topologyChanged();await waitUntil(()=>!f.read('B','copy').fileInfo.webZipPendingSync);
});
test('invalid editors and unavailable new bytes cannot publish or enqueue work',async t=>{
    const f=setup(t);await assert.rejects(f.service.publish({...f.input(),deviceId:'outsider'}),/WEB_ZIP_EDIT_DENIED/);
    f.state.content=false;await assert.rejects(f.service.publish(f.input()),/WEB_ZIP_CONTENT_NOT_READY/);assert.equal(f.writes.length,0);assert.equal(fs.existsSync(f.filename),false);
});
test('client-claimed source fields alone cannot create a sync job or extend a creator approval to another record',async t=>{
    const f=setup(t);f.state.trusted=false;f.state.available=true;f.read('A','origin').fileInfo.webZipEditors=[];
    await f.service.publish(f.input());assert.equal(f.read('B','copy').fileInfo.webZipPendingSync,undefined);assert.equal(f.read('A','origin').fileInfo.id,'original-file');
    await f.service.approve({sessionId:'B',messageId:'copy',fileId:'new-file',creatorDeviceId:'creator',deviceId:'other-editor'});
    assert.deepEqual(f.read('A','origin').fileInfo.webZipEditors,[]);
});
test('an unreadable sync journal blocks new deferred work but leaves an independent webpage editable',async t=>{
    const f=setup(t);fs.writeFileSync(f.filename,'{broken');f.restart();await assert.rejects(f.service.publish(f.input()),/WEB_ZIP_SYNC_STORAGE/);
    delete f.read('B','copy').forwardedFrom;await f.service.publish(f.input());assert.equal(f.read('B','copy').fileInfo.id,'new-file');assert.equal(fs.readFileSync(f.filename,'utf8'),'{broken');
});
test('the real eligibility adapter requires source membership or an online visible helper, never a global online stranger',()=>{
    const code=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');const context={sessions:new Map(),io:{sockets:{sockets:new Map()}},canUseTunnelCapability:()=>true,getNearbyCandidates:()=>[]};
    const section=code.slice(code.indexOf('function canSyncWebZipSource('),code.indexOf('const webZipSync =',code.indexOf('function canSyncWebZipSource(')));
    vm.runInNewContext(section,context);const source={devices:new Map([['H',{socketId:'helper-A'}]])},target={devices:new Map([['editor',{socketId:'editor-B'}]])};
    context.sessions.set('A',source);context.sessions.set('B',target);context.io.sockets.sockets.set('helper-A',{connected:true,data:{deviceId:'H'}});context.io.sockets.sockets.set('editor-B',{connected:true,data:{deviceId:'editor'}});
    assert.equal(context.canSyncWebZipSource('editor','A'),false);
    target.devices.set('H',{socketId:'helper-B'});context.io.sockets.sockets.set('helper-B',{connected:true,data:{deviceId:'H'}});assert.equal(context.canSyncWebZipSource('editor','A'),true);
    context.io.sockets.sockets.get('helper-A').connected=false;assert.equal(context.canSyncWebZipSource('editor','A'),false);
    source.devices.set('editor',{socketId:'editor-A'});context.io.sockets.sockets.set('editor-A',{connected:true,data:{deviceId:'editor'}});assert.equal(context.canSyncWebZipSource('editor','A'),true);
    assert.equal(target.devices.get('editor').socketId,'editor-B','the adapter only reads memberships');
});
