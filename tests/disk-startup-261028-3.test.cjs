'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openDiskRepository}=require('../server/disk-repository');
const {createTelegramDriveStore}=require('../server/telegram-drive');
test('startup ancestor repair does not repeatedly project every owner file',t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'disk-startup-261028-'));
    const repository=openDiskRepository(dir);t.after(()=>{repository.close();fs.rmSync(dir,{recursive:true,force:true});});
    const files=Array.from({length:120},(_,i)=>({id:'legacy-'+i,ownerId:'alice',folderPath:'父目录/子目录',name:i+'.txt',size:1,parts:[],createdAt:123}));
    repository.replace('files',files,file=>file.id);
    let projected=0;const project=repository.projectFiles;
    repository.projectFiles=(items,...args)=>{projected+=items.length;return project(items,...args);};
    const started=performance.now(),drive=createTelegramDriveStore({dataDir:dir});
    const startupProjected=projected;
    assert.ok(drive.getDirectory('alice','父目录'));assert.ok(drive.getDirectory('alice','父目录/子目录'));
    assert.equal(drive.getDirectory('alice','父目录').createdAt,123);
    assert.ok(startupProjected<=files.length*2,`${startupProjected} repeated physical projections for ${files.length} files; ${Math.round(performance.now()-started)}ms`);
});
test('startup ancestor repair still rejects a directory blocked by a same-owner file',t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'disk-startup-collision-'));
    const repository=openDiskRepository(dir);t.after(()=>{repository.close();fs.rmSync(dir,{recursive:true,force:true});});
    repository.replace('files',[{id:'block',ownerId:'alice',folderPath:'',name:'父目录',parts:[]},{id:'child',ownerId:'alice',folderPath:'父目录/子目录',name:'child.txt',parts:[]}],v=>v.id);
    assert.throws(()=>createTelegramDriveStore({dataDir:dir}),/DISK_NAME_CONFLICT/);
});
