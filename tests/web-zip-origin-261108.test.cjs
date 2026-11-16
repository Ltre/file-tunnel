'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),os=require('node:os');
const {createWebZipSync}=require('../server/web-zip-sync'),{createWebZipCredentials}=require('../server/web-zip-credentials');
test('repeated forwarded-page publication preserves its verified source after a pending edit and server restart',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-origin-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),start=source.indexOf('    isForwardedCopy: (sessionId,messageId,file,origin) => {'),end=source.indexOf('    canPublish:',start);
    const original={id:'origin',type:'file',fileInfo:{id:'original-file',name:'page.html.zip',size:3,type:'application/zip',webZip:true,creatorDeviceId:'creator',webZipEditors:['editor']}};
    const copy={id:'copy',type:'file',fileInfo:{...original.fileInfo,id:'copy-file'},forwardedFrom:{sessionId:'A',messageId:'origin'}};
    const records=new Map([['A:origin',original],['B:copy',copy]]),saved=new Map([['B:copy',{source:'cross-tunnel-forward',payload_json:JSON.stringify(copy)}]]);
    const context={sessions:new Map(),getHistoryMessageEntry:()=>null,infraStore:{get:(_sql,[s,id])=>saved.get(s+':'+id)}};
    vm.runInNewContext('globalThis.adapter={'+source.slice(start,end)+'};',context);
    let visible=false;
    const dependencies={filename:path.join(dir,'pending.json'),credentials:createWebZipCredentials({dataDir:dir}),readRecord:(s,id)=>records.get(s+':'+id),
        writeRecord:async(s,previous,next,options={})=>{assert.notEqual(options.check?.(),false);records.set(s+':'+next.id,next);saved.set(s+':'+next.id,{source:options.source||'web-zip-updated',payload_json:JSON.stringify(next)});return next;},
        canPublish:()=>true,hasContent:()=>true,canSync:()=>visible,isForwardedCopy:context.adapter.isForwardedCopy};
    let service=createWebZipSync(dependencies);
    await service.publish({sessionId:'B',messageId:'copy',fileId:'copy-file',deviceId:'editor',fileInfo:{id:'first-edit',name:'first.html.zip',size:4,type:'application/zip'}});
    assert.ok(records.get('B:copy').fileInfo.webZipPendingSync);
    // Existing pending journals predate signed provenance. They remain a
    // private, validated source link when the editor publishes again.
    delete records.get('B:copy').fileInfo.webZipSourceProof;
    const journal=JSON.parse(fs.readFileSync(dependencies.filename));delete journal.jobs[0].file.webZipSourceProof;fs.writeFileSync(dependencies.filename,JSON.stringify(journal));
    service=createWebZipSync(dependencies);
    await service.publish({sessionId:'B',messageId:'copy',fileId:'first-edit',deviceId:'editor',fileInfo:{id:'second-edit',name:'second.html.zip',size:5,type:'application/zip'}});
    assert.ok(records.get('B:copy').fileInfo.webZipPendingSync,'the second edit must remain linked to its original, not become an independent page');
    visible=true;service.topologyChanged();
    for(let n=0;n<100&&records.get('B:copy').fileInfo.webZipPendingSync;n++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(records.get('A:origin').fileInfo.id,'second-edit');
    await service.publish({sessionId:'B',messageId:'copy',fileId:'second-edit',deviceId:'editor',fileInfo:{id:'third-edit',name:'third.html.zip',size:6,type:'application/zip'}});
    assert.equal(records.get('A:origin').fileInfo.id,'third-edit');
});
test('source provenance cannot be reused for another anchor or substituted for an edit credential',t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-proof-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const credentials=createWebZipCredentials({dataDir:dir}),scope={sessionId:'B',messageId:'copy',creatorDeviceId:'creator',rootId:'root',sourceSessionId:'A',sourceMessageId:'origin'};
    const proof=credentials.issueSource(scope);assert.equal(credentials.verifySource(proof,scope),true);assert.equal(credentials.verify(proof,scope),false);
    for(const field of Object.keys(scope))assert.equal(credentials.verifySource(proof,{...scope,[field]:'another'}),false,field);
    assert.equal(credentials.verifySource(proof+'x',scope),false);
});

test('an old completed copy recovers its exact origin with the cached signed edit capability, but not forged or revoked scope',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-completed-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const original={id:'origin',type:'file',fileInfo:{id:'root',name:'page.html.zip',size:3,type:'application/zip',webZip:true,creatorDeviceId:'creator',webZipEditors:['editor']}};
    const copy={id:'copy',type:'file',fileInfo:{...original.fileInfo,id:'copy-file'},forwardedFrom:{sessionId:'A',messageId:'origin'}};
    const records=new Map([['A:origin',original],['B:copy',copy]]);let first=true;
    const dependencies={filename:path.join(dir,'pending.json'),credentials:createWebZipCredentials({dataDir:dir}),readRecord:(s,id)=>records.get(s+':'+id),writeRecord:async(s,previous,next)=>{records.set(s+':'+next.id,next);},canPublish:()=>true,hasContent:()=>true,canSync:()=>true,isForwardedCopy:()=>first};
    let service=createWebZipSync(dependencies);const token=service.issueCredential({sessionId:'B',messageId:'copy',fileId:'copy-file',deviceId:'editor'});
    await service.publish({sessionId:'B',messageId:'copy',fileId:'copy-file',deviceId:'editor',editCredential:token,fileInfo:{id:'old-edit',name:'old.html.zip',size:4,type:'application/zip'}});
    first=false;delete records.get('B:copy').fileInfo.webZipSourceProof;service=createWebZipSync(dependencies);
    assert.throws(()=>service.issueCredential({sessionId:'B',messageId:'copy',fileId:'old-edit',deviceId:'editor'}),/SOURCE_UNVERIFIED/,'missing original credentials must not silently detach the old source');
    const refresh=()=>service.issueCredential({sessionId:'B',messageId:'copy',fileId:'old-edit',deviceId:'editor',editCredential:token});
    assert.equal(refresh(),token,'refresh retains the original source scope');
    const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),handlers=new Map();
    vm.runInNewContext(server.slice(server.indexOf("    socket.on('web-zip-edit-credential',"),server.indexOf("    socket.on('web-zip-edit-request',")),{socket:{on:(event,run)=>handlers.set(event,run)},sessions:new Map([['B',{devices:new Map([['editor',{}]])}]]),currentSession:'B',currentDevice:'editor',checkMessageRate:()=>true,webZipSync:service});
    const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),memory=new Map([['webZipEditCredential:editor:B:copy',token]]);
    const client={state:{sessionId:'B',deviceId:'editor',socket:{connected:true,timeout(){return this;},emit:(event,data,ack)=>handlers.get(event)(data,result=>ack(null,result))}},localStorage:{getItem:key=>memory.get(key)},formatWebZipText:value=>value,rememberWebZipEditCredential:credential=>memory.set('webZipEditCredential:editor:B:copy',credential)};
    vm.runInNewContext(app.slice(app.indexOf('async function requestWebZipEditCredential('),app.indexOf('function renderWebZipRecordLabels(')),client);
    assert.equal(await client.requestWebZipEditCredential(records.get('B:copy').fileInfo,'copy'),token,'actual browser request and server handler pass the cached capability through');
    memory.clear();await assert.rejects(client.requestWebZipEditCredential(records.get('B:copy').fileInfo,'copy'),/原网页关联尚未核验/);memory.set('webZipEditCredential:editor:B:copy',token);
    records.get('B:copy').forwardedFrom.messageId='unrelated';assert.throws(refresh,/SOURCE_UNVERIFIED/);records.get('B:copy').forwardedFrom.messageId='origin';
    records.get('A:origin').fileInfo.webZipPermissionUpdatedAt=5;assert.throws(refresh,/SOURCE_UNVERIFIED/);delete records.get('A:origin').fileInfo.webZipPermissionUpdatedAt;
    await service.publish({sessionId:'B',messageId:'copy',fileId:'old-edit',deviceId:'editor',editCredential:refresh(),fileInfo:{id:'new-edit',name:'new.html.zip',size:5,type:'application/zip'}});
    assert.equal(records.get('A:origin').fileInfo.id,'new-edit');assert.ok(records.get('B:copy').fileInfo.webZipSourceProof);
});
