'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createFixture}=require('./support/pending-save-261012-fixture.cjs');
test('moving owner content outside a collaboration directory requires acknowledgement',async t=>{
    const f=await createFixture();t.after(()=>f.close());
    const drive=f.api.spaces.get('');drive.createDirectory('alice','公开/子目录',30);
    const file=drive.putMetadataObject(f.auth.user('alice'),'公开/子目录','内容.txt','text/plain',{},30);
    const login=await fetch(f.base+'/fixture-login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'id=alice',redirect:'manual'});
    const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
    const call=async(route,method='GET',body)=>{const response=await fetch(f.base+'/api/telegram/drive'+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
    const grant=await call('/collaborations/invitations','POST',{kind:'directory',path:'公开'});assert.equal(grant.status,201,JSON.stringify(grant.data));
    const preflight=await call('/moves/preflight','POST',{destinationPath:'甲目录',items:[{kind:'file',id:file.id}]});
    assert.equal(preflight.status,200);assert.equal(preflight.data.requiresConfirmation,true);
    assert.equal(drive.get('alice',file.id).folderPath,'公开/子目录');
    const outsider=await fetch(f.base+'/api/telegram/drive/moves/preflight',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({destinationPath:'甲目录',items:[{kind:'file',id:file.id}]})});
    assert.equal(outsider.status,401,'preflight cannot expose another account without authentication');
    const move={folderPath:'甲目录',requestId:'exposed-move-confirmation-261029'};
    const denied=await call('/files/'+file.id,'PATCH',move);
    assert.equal(denied.data.error,'EXPOSED_CONTENT_MOVE_CONFIRMATION_REQUIRED',JSON.stringify(denied));
    assert.equal((await call('/operations')).data.operations.filter(job=>job.requestId===move.requestId).length,0,'declined prerequisite must not start transfer history');
    assert.equal(drive.get('alice',file.id).folderPath,'公开/子目录');
    const accepted=await call('/files/'+file.id,'PATCH',{...move,confirm_exposed_move:true});assert.equal(accepted.status,202,JSON.stringify(accepted));
    for(let n=0;n<50;n++){const job=await call('/operations/'+accepted.data.operation_id);if(job.data.status==='completed'){
        assert.equal(drive.get('alice',file.id).folderPath,'甲目录');
        const repeated=await call('/files/'+file.id,'PATCH',{...move,confirm_exposed_move:true});assert.deepEqual(repeated,accepted);
        const changed=await call('/files/'+file.id,'PATCH',{...move,folderPath:'乙目录',confirm_exposed_move:true});assert.equal(changed.data.error,'CONTENT_WRITE_CONFLICT');
        return;
    }assert.notEqual(job.data.status,'failed',JSON.stringify(job));await new Promise(r=>setTimeout(r,10));}
    assert.fail('acknowledged move did not finish');
});
for(const kind of ['file','directory'])for(const exposure of ['collaboration','static'])test(exposure+' '+kind+' moves keep source intact until acknowledged',async t=>{
    const f=await createFixture();t.after(()=>f.close());const drive=f.api.spaces.get('');drive.createDirectory('alice','公开/子目录',30);drive.createDirectory('alice','移动目标',30);
    const file=drive.putMetadataObject(f.auth.user('alice'),'公开/子目录','移动.txt','text/plain',{},30);
    if(exposure==='static')require('../server/disk-static-resources').createDiskStaticResources({dataDir:f.dataDir}).create({userId:'alice',diskSpace:''},drive,{preset:'permanent',items:[{kind:'directory',path:'公开'}]});
    const login=await fetch(f.base+'/fixture-login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'id=alice'}),cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
    const call=async(route,method,body)=>{const r=await fetch(f.base+'/api/telegram/drive'+route,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
    if(exposure==='collaboration')assert.equal((await call('/collaborations/invitations','POST',{kind:'directory',path:'公开'})).status,201);
    const route=kind==='file'?'/files/'+file.id:'/directories',body=kind==='file'?{folderPath:'移动目标'}:{path:'公开/子目录',destinationPath:'移动目标'};
    assert.equal((await call(route,'PATCH',body)).data.error,'EXPOSED_CONTENT_MOVE_CONFIRMATION_REQUIRED');
    assert.ok(drive.getDirectory('alice','公开/子目录'));assert.equal(drive.get('alice',file.id).folderPath,'公开/子目录');
    assert.equal((await call(route,'PATCH',{...body,confirm_exposed_move:'true'})).data.error,'EXPOSED_CONTENT_MOVE_CONFIRMATION_REQUIRED');
    const moved=await call(route,'PATCH',{...body,confirm_exposed_move:true});assert.equal(moved.status,202,JSON.stringify(moved));
    for(let i=0;i<50;i++){const job=await call('/operations/'+moved.data.operation_id,'GET');if(job.data.status==='completed')break;assert.notEqual(job.data.status,'failed',JSON.stringify(job));await new Promise(r=>setTimeout(r,10));}
    assert.equal(drive.get('alice',file.id).folderPath,kind==='file'?'移动目标':'移动目标/子目录');
});
test('moving within a collaboration directory does not require an impact acknowledgement',async t=>{
    const f=await createFixture();t.after(()=>f.close());const drive=f.api.spaces.get('');drive.createDirectory('alice','公开/子目录',30);
    const file=drive.putMetadataObject(f.auth.user('alice'),'公开/子目录','留在范围.txt','text/plain',{},30);
    const login=await fetch(f.base+'/fixture-login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'id=alice'}),cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
    const call=async(route,body)=>fetch(f.base+'/api/telegram/drive'+route,{method:route.includes('invitations')?'POST':'PATCH',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await call('/collaborations/invitations',{kind:'directory',path:'公开'})).status,201);
    const moved=await call('/files/'+file.id,{folderPath:'公开'});assert.equal(moved.status,202,await moved.text());
});

test('move acknowledgement cannot grant ownership or bypass protected rename',async t=>{
    const f=await createFixture();t.after(()=>f.close());const drive=f.api.spaces.get('');
    drive.createDirectory('alice','公开',30);
    const file=drive.putMetadataObject(f.auth.user('alice'),'公开','不可越权.txt','text/plain',{},30);
    require('../server/disk-static-resources').createDiskStaticResources({dataDir:f.dataDir}).create({userId:'alice',diskSpace:''},drive,{preset:'permanent',items:[{kind:'directory',path:'公开'}]});
    for(const id of ['bob','alice']){
        const login=await fetch(f.base+'/fixture-login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'id='+id});
        const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
        const response=await fetch(f.base+'/api/telegram/drive/files/'+file.id,{method:'PATCH',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(id==='bob'?{folderPath:'乙目录',confirm_exposed_move:true}:{name:'越过保护.txt',confirm_exposed_move:true})});
        const data=await response.json();assert.ok(response.status>=400,JSON.stringify(data));
        if(id==='alice')assert.equal(data.error,'STATIC_RESOURCE_ACTIVE');
        assert.equal(drive.get('alice',file.id).folderPath,'公开');assert.equal(drive.get('alice',file.id).name,'不可越权.txt');
    }
});
