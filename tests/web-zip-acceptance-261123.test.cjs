'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createWebZipLegacy,CUTOFF}=require('../server/web-zip-legacy');
const {resolveWebZipEditRequest}=require('../server/web-zip-edit-request');
const oldFile=()=>({id:'old-file',name:'old.html.zip',webZip:true,size:3,type:'application/zip',creatorDeviceId:'creator',webZipUpdatedAt:CUTOFF-1,timestamp:CUTOFF-500});
function fixture(t){
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'webzip-legacy-261123-'));
    t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('webzip-legacy-261123-'));fs.rmSync(directory,{recursive:true,force:true});});
    const file=oldFile(),message={id:'old-record',type:'file',timestamp:CUTOFF-500,fileInfo:file},rows=[{session_id:'tunnel',message_id:message.id,payload_json:JSON.stringify(message)}];
    const store={query:(_query,[offset])=>rows.slice(offset,offset+1000)},filename=path.join(directory,'legacy.json');
    const legacy=createWebZipLegacy({filename});legacy.initialize(store);
    return {legacy,filename,store,rows,file,message};
}
test('历史 ZIP 清单仅冻结首次部署前已有内容，保留协作权限变化，重发/新内容/回填日期不能获得豁免',t=>{
    const f=fixture(t);
    assert.equal(f.legacy.allows(f.file,f.message.id,'tunnel'),true);
    assert.equal(f.legacy.allows({...f.file,webZipEditors:['editor'],webZipPermissionUpdatedAt:Date.now()},f.message.id,'tunnel'),true);
    for(const change of [{id:'other'},{size:4},{name:'edited.html.zip'},{timestamp:Date.now()},{webZipRevision:1},{webZipSha256:'0'.repeat(64)},{webZipTrustIntegrityStamp:'new-stamp'},{data:'changed inline archive'}])
        assert.equal(f.legacy.allows({...f.file,...change},f.message.id,'tunnel'),false,JSON.stringify(change));
    assert.equal(f.legacy.allows(f.file,'other-record','tunnel'),false);
    assert.equal(f.legacy.allows(f.file,f.message.id,'other-tunnel'),false);
    f.rows.push({...f.rows[0],message_id:'backdated-record'});
    const restarted=createWebZipLegacy({filename:f.filename});restarted.initialize(f.store);
    assert.equal(restarted.allows(f.file,f.message.id,'tunnel'),true);
    assert.equal(restarted.allows(f.file,'backdated-record','tunnel'),false,'重新启动不得扩充冻结清单');
});
test('历史 ZIP 截止日按 2026-11-22 新加坡日末，缺失或超出时间以及损坏清单均不能豁免',t=>{
    const f=fixture(t);
    assert.equal(new Date(CUTOFF).toISOString(),'2026-11-22T16:00:00.000Z');
    fs.writeFileSync(f.filename,'broken');const errors=[];
    const damaged=createWebZipLegacy({filename:f.filename,log:(...args)=>errors.push(args)});damaged.initialize(f.store);
    assert.equal(damaged.allows(f.file,f.message.id,'tunnel'),false);assert.equal(errors.length,1);
    const otherName=path.join(path.dirname(f.filename),'future.json');
    const future={...f.message,fileInfo:{...f.file,webZipUpdatedAt:CUTOFF-1000,timestamp:CUTOFF}};
    const empty=createWebZipLegacy({filename:otherName});empty.initialize({query:()=>[{...f.rows[0],payload_json:JSON.stringify(future)}]});
    assert.equal(empty.allows(future.fileInfo,future.id,'tunnel'),false);
});
test('编辑申请按明确记录读取持久内容，身份相同仍由授权层判断，错误不再一律声称无需申请',()=>{
    const file=oldFile(),message={id:'durable-record',type:'file',fileInfo:file};let reads=0;
    const input={sessionId:'tunnel',messageId:message.id,fileId:file.id,readRecord:(s,m)=>{assert.equal(s,'tunnel');assert.equal(m,message.id);reads++;return message;},listRecords:()=>{throw Error('unnecessary history scan');}};
    assert.deepEqual(resolveWebZipEditRequest(input),{fileInfo:file,messageId:message.id});assert.equal(reads,1);
    assert.throws(()=>resolveWebZipEditRequest({...input,fileId:'missing'}),/WEB_ZIP_RECORD_NOT_FOUND/);
    assert.throws(()=>resolveWebZipEditRequest({...input,readRecord:()=>({...message,fileInfo:{...file,creatorDeviceId:''}})}),/WEB_ZIP_CREATOR_MISSING/);
    assert.equal(resolveWebZipEditRequest({...input,messageId:'',listRecords:()=>[message]}).messageId,message.id);
});
test('申请前刷新并确认 Socket 证明，共享同作用域在途刷新，不把旧账号响应用于新账号申请',async()=>{
    const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');let account='alice',access=0,proof=0,auth=0,requests=0;
    const socket={id:'socket',connected:true,timeout(){return this;},emit(event,data,ack){
        if(event==='web-zip-auth'){auth++;ack(null,{ok:true});return;}
        if(event==='web-zip-edit-request'){requests++;assert.equal(data.messageId,'record');ack(null,{ok:true,delivered:true});}
    }};
    const context=vm.createContext({state:{socket,sessionId:'tunnel',deviceId:'device'},window:{DiskClient:{getAccount:()=>account}},
        document:{getElementById:()=>null,querySelectorAll:()=>[],querySelector:()=>null},savedTunnelGrant:()=> 'grant',showAppToast(){},rememberWebZipEditCredential(){},formatWebZipText:x=>x,
        fetch:async url=>{if(url.endsWith('/access')){access++;return{ok:true,json:async()=>({allowed:true})};}proof++;return{ok:true,json:async()=>({ok:true,proof:'fresh'})};}});
    vm.runInContext(source.slice(source.indexOf('let webZipPublishAllowed='),source.indexOf('async function signWebZipArchive(')),context);
    vm.runInContext(source.slice(source.indexOf('async function requestWebZipEditPermission('),source.indexOf('async function getWebZipBlob(')),context);
    await Promise.all([context.refreshWebZipAccess(),context.refreshWebZipAccess()]);assert.equal(access,1);assert.equal(proof,1);assert.equal(auth,1);
    await context.requestWebZipEditPermission({id:'file',recordMessageId:'record'});assert.equal(requests,1);assert.equal(auth,2);
    socket.emit=(event,_data,ack)=>{if(event==='web-zip-auth'){account='bob';ack(null,{ok:true});}else requests++;};
    await assert.rejects(context.requestWebZipEditPermission({id:'file'}),/账号操作未完成/);assert.equal(requests,1);
});
