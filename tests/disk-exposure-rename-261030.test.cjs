'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createFixture}=require('./support/pending-save-261012-fixture.cjs');

async function setup(t){
    const f=await createFixture();t.after(()=>f.close());
    const drive=f.api.spaces.get('');drive.createDirectory('alice','公开/子目录',30);
    const file=drive.putMetadataObject(f.auth.user('alice'),'公开/子目录','原文件.txt','text/plain',{},30);
    const login=await fetch(f.base+'/fixture-login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'id=alice'});
    const cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
    const call=async(route,method='GET',body,accountCookie=cookie)=>{
        const response=await fetch(f.base+'/api/telegram/drive'+route,{method,headers:{Cookie:accountCookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
        return {status:response.status,data:await response.json()};
    };
    const finish=async result=>{
        assert.equal(result.status,202,JSON.stringify(result));
        for(let i=0;i<60;i++){
            const job=(await call('/operations/'+result.data.operation_id)).data;
            if(job.status==='completed')return job.result;
            assert.notEqual(job.status,'failed',JSON.stringify(job));await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.fail('rename operation did not complete');
    };
    return {...f,drive,file,call,finish};
}

for(const exposure of ['collaboration','static'])for(const kind of ['file','directory'])test(exposure+' '+kind+' rename requires acknowledgement before any mutation',async t=>{
    const f=await setup(t),selection=kind==='file'?{kind,id:f.file.id}:{kind,path:'公开/子目录'};
    if(exposure==='collaboration')assert.equal((await f.call('/collaborations/invitations','POST',{kind:'directory',path:'公开'})).status,201);
    else require('../server/disk-static-resources').createDiskStaticResources({dataDir:f.dataDir}).create({userId:'alice',diskSpace:''},f.drive,{preset:'permanent',items:[{kind:'directory',path:'公开'}]});
    const preflight=await f.call('/renames/preflight','POST',{...selection,name:'新名称'});
    assert.equal(preflight.status,200,JSON.stringify(preflight));assert.equal(preflight.data.requiresConfirmation,true);
    const route=kind==='file'?'/files/'+f.file.id:'/directories',body=kind==='file'?{name:'新名称.txt'}:{path:selection.path,name:'新名称'};
    const before=(await f.call('/operations')).data.operations.length;
    for(const confirmation of [undefined,'true']){
        const blocked=await f.call(route,'PATCH',{...body,confirm_exposed_rename:confirmation});
        assert.equal(blocked.status,409,JSON.stringify(blocked));assert.equal(blocked.data.error,'EXPOSED_CONTENT_RENAME_CONFIRMATION_REQUIRED');
    }
    assert.equal((await f.call('/operations')).data.operations.length,before,'refused rename must not create a job');
    assert.equal(f.drive.get('alice',f.file.id).name,'原文件.txt');assert.ok(f.drive.getDirectory('alice','公开/子目录'));
    await f.finish(await f.call(route,'PATCH',{...body,confirm_exposed_rename:true}));
    assert.equal(f.drive.get('alice',f.file.id).name,kind==='file'?'新名称.txt':'原文件.txt');
    assert.equal(f.drive.get('alice',f.file.id).folderPath,kind==='file'?'公开/子目录':'公开/新名称');
});

test('rename checks cover direct file grants and directories containing a shared item',async t=>{
    const f=await setup(t);
    assert.equal((await f.call('/collaborations/invitations','POST',{kind:'file',fileId:f.file.id})).status,201);
    for(const selection of [{kind:'file',id:f.file.id,name:'另一个.txt'},{kind:'directory',path:'公开',name:'新公开'}]){
        const result=await f.call('/renames/preflight','POST',selection);assert.equal(result.status,200);assert.equal(result.data.requiresConfirmation,true);
    }
});

test('static file sharing added after preflight is checked again at the rename boundary',async t=>{
    const f=await setup(t),selection={kind:'file',id:f.file.id,name:'新文件.txt'};
    assert.equal((await f.call('/renames/preflight','POST',selection)).data.requiresConfirmation,false);
    const statics=require('../server/disk-static-resources').createDiskStaticResources({dataDir:f.dataDir});
    const link=statics.create({userId:'alice',diskSpace:''},f.drive,{preset:'permanent',items:[{kind:'file',id:f.file.id}]});
    assert.equal((await f.call('/renames/preflight','POST',{...selection,exposureConfirmed:true})).data.requiresConfirmation,true,'preflight must ignore a spoofed delete acknowledgement');
    assert.equal((await f.call('/renames/preflight','POST',{kind:'directory',path:'公开',name:'另一个'})).data.requiresConfirmation,true);
    assert.equal((await f.call('/files/'+f.file.id,'PATCH',{name:selection.name,exposureConfirmed:true})).data.error,'EXPOSED_CONTENT_RENAME_CONFIRMATION_REQUIRED');
    statics.revoke({userId:'alice',diskSpace:''},link.id);
    assert.equal((await f.call('/renames/preflight','POST',selection)).data.requiresConfirmation,false,'revoked sharing does not keep requiring confirmation');
    await f.finish(await f.call('/files/'+f.file.id,'PATCH',{name:selection.name}));
});

test('unexposed rename stays available and acknowledgement cannot cross account ownership',async t=>{
    const f=await setup(t);
    assert.equal((await f.call('/renames/preflight','POST',{kind:'file',id:f.file.id,name:'普通.txt'})).data.requiresConfirmation,false);
    await f.finish(await f.call('/files/'+f.file.id,'PATCH',{name:'普通.txt'}));
    const login=await fetch(f.base+'/fixture-login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'id=bob'}),cookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
    for(const [route,method,body] of [['/renames/preflight','POST',{kind:'file',id:f.file.id,name:'越权.txt'}],['/files/'+f.file.id,'PATCH',{name:'越权.txt',confirm_exposed_rename:true}]]){
        const response=await f.call(route,method,body,cookie);assert.ok(response.status>=400,JSON.stringify(response));
    }
    assert.equal(f.drive.get('alice',f.file.id).name,'普通.txt');
    assert.equal((await f.call('/renames/preflight','POST',{kind:'file',id:f.file.id,name:'无登录.txt'},'')).status,401);
});
