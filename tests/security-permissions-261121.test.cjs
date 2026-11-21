'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Readable}=require('node:stream');
const {createDiskAuth}=require('../server/disk-auth');
const {isRiskyFile,normalizeMime,assertRiskyUploadAllowed}=require('../server/disk-risky-files');
const {createObjectStorage}=require('../server/object-storage');

test('风险 MIME 与扩展名独立判断，普通 ZIP 不误拦截',()=>{
    for(const [name,mime] of [
        ['safe.txt','text/html ; charset=utf-8'],['safe.txt','IMAGE/SVG+XML ;charset=UTF-8'],
        ['a.svg','image/png'],['a.svgz','application/octet-stream'],['a.mjs','application/octet-stream'],
        ['a.css','text/plain'],['a.wasm','application/octet-stream'],['.htaccess','text/plain'],
        ['web.config','text/plain'],['test.jsp','text/plain'],['test.xml','text/plain'],
        ['test.mhtml','text/plain']
    ]) assert.equal(isRiskyFile(name,mime),true,`${name} / ${mime}`);
    assert.equal(isRiskyFile('photos.zip','application/zip'),false);
    assert.equal(isRiskyFile('annual.pdf','application/pdf'),false);
    assert.equal(normalizeMime('text/html ; charset=utf-8'),'text/html');
    assert.equal(normalizeMime('text/html\nSet-Cookie: x=y'),'application/octet-stream');
});

test('用户默认无三项权限，修改持久生效并有独立版本和操作者审计',t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'disk-permission-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const auth=createDiskAuth({dataDir:dir}),alice=auth.fromTelegram({id:'992239001',name:'Alice'});
    for(const key of ['disk.s3.manage','disk.riskyUpload','webZip.publishEdit']) assert.equal(auth.hasPermission(alice.id,key),false);
    assert.throws(()=>assertRiskyUploadAllowed(auth,alice.id,'page.xhtml','application/octet-stream'),/DISK_RISKY_UPLOAD_FORBIDDEN/);
    assert.doesNotThrow(()=>assertRiskyUploadAllowed(auth,alice.id,'photo.jpg','image/jpeg'));
    assert.throws(()=>auth.setPermissions(alice.id,{'webZip.publishEdit':'yes'}),/DISK_PERMISSION_INVALID/);
    const granted=auth.setPermissions(alice.id,{'disk.riskyUpload':true,'webZip.publishEdit':true},'administrator');
    assert.equal(granted.permissionVersion,1);
    assert.equal(auth.hasPermission(alice.id,'disk.riskyUpload'),true);
    assert.doesNotThrow(()=>assertRiskyUploadAllowed(auth,alice.id,'page.xhtml','text/html ; charset=utf-8'));
    const reopened=createDiskAuth({dataDir:dir});
    assert.equal(reopened.hasPermission(alice.id,'webZip.publishEdit'),true);
    assert.equal(reopened.setPermissions(alice.id,{'webZip.publishEdit':false},'administrator').permissionVersion,2);
    assert.equal(reopened.hasPermission(alice.id,'webZip.publishEdit'),false);
});

test('S3 对象 PUT 和 Copy 均须检查目标用户的风险上传权限',async()=>{
    const checks=[];
    const api=createObjectStorage({
        spaces:{get:()=>({adminFiles:()=>[{ownerId:'alice',folderPath:'',name:'source.txt',type:'text/html',size:1}],listDirectories:()=>[]})},
        auth:{user:id=>({id})},
        assertRiskyUpload:(id,name,type)=>{checks.push([id,name,type]);if(isRiskyFile(name,type))throw Error('DISK_RISKY_UPLOAD_FORBIDDEN');},
        mountedNamespace:{assertWritable(){},object:()=>null},
        getDefaultBackend:()=>({token:'unused'}),openRange:()=>Readable.from([]),uploadStream:()=>{throw Error('should-not-upload');}
    });
    await assert.rejects(api.put({userId:'alice',diskSpace:''},'index.html',Readable.from([]),{size:0,contentType:'text/plain'}),/DISK_RISKY_UPLOAD_FORBIDDEN/);
    await assert.rejects(api.put({userId:'alice',diskSpace:''},'safe.txt',Readable.from([]),{size:0,contentType:'text/html ; charset=utf-8'}),/DISK_RISKY_UPLOAD_FORBIDDEN/);
    await assert.rejects(api.copy({userId:'alice',diskSpace:''},'source.txt',{userId:'alice',diskSpace:''},'dest.txt'),/DISK_RISKY_UPLOAD_FORBIDDEN/);
    assert.equal(checks.length,3);
});
