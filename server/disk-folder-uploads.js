'use strict';
const crypto=require('node:crypto');
const {normalizeTelegramDrivePath:normalize}=require('./telegram-drive');
const key=file=>[file.folderPath||'',file.name].join('/');
function createFolderUploads({repository,settings,operations}){
    const save=item=>repository.replace('folder_uploads',[...repository.load('folder_uploads').filter(v=>v.id!==item.id),item],v=>v.id);
    function get(id,scope){const item=repository.load('folder_uploads').find(v=>v.id===id&&v.ownerId===scope.userId&&v.diskSpace===scope.diskSpace);if(!item)throw new Error('FOLDER_UPLOAD_NOT_FOUND');return item;}
    function refresh(item){for(const batch of item.batches){const op=operations.get(batch.operationId,{userId:item.ownerId,diskSpace:item.diskSpace});batch.status=op?.status||batch.status;if(op?.status==='completed')batch.completed=true;}return item;}
    return {get(id,scope){return repository.atomic(()=>{const item=get(id,scope),before=JSON.stringify(item.batches);refresh(item);if(JSON.stringify(item.batches)!==before)save(item);return item;});},create(scope,drive,input){
        const limits=settings.get(scope.userId),files=input.files,directories=input.directories;
        if(!Array.isArray(files)||!Array.isArray(directories)||files.length+directories.length>10000||!directories.length)throw new Error('FOLDER_UPLOAD_INVALID');
        const seen=new Set();let total=0;
        for(const file of files){if(!file||typeof file.name!=='string'||!file.name||file.name==='.'||file.name==='..'||file.name!==file.name.trim()||file.name.length>180||/[\\/:*?"<>|\u0000-\u001f]/.test(file.name)||!Number.isSafeInteger(file.size)||file.size<0||file.size>2000*1024*1024)throw new Error('FOLDER_UPLOAD_INVALID');const path=normalize(file.folderPath||'');if(path!==file.folderPath||path.split('/').filter(Boolean).length>limits.maxDirectoryDepth)throw new Error('telegram-drive-folder-depth-exceeded');if(seen.has(key(file)))throw new Error('DISK_NAME_CONFLICT');seen.add(key(file));total+=file.size;}
        if(total>limits.folderUploadMaxBytes)throw new Error('FOLDER_UPLOAD_TOO_LARGE');
        const dirs=[...new Set(directories)];for(const path of dirs){if(normalize(path)!==path||!path||path.split('/').length>limits.maxDirectoryDepth)throw new Error('telegram-drive-folder-depth-exceeded');if(seen.has(path)||drive.getDirectory(scope.userId,path))throw new Error('DISK_NAME_CONFLICT');}
        for(const file of files)if(!dirs.includes(file.folderPath)||drive.adminFiles().some(f=>f.ownerId===scope.userId&&f.folderPath===file.folderPath&&f.name===file.name))throw new Error('DISK_NAME_CONFLICT');
        return repository.atomic(()=>{for(const path of dirs.sort((a,b)=>a.split('/').length-b.split('/').length))drive.createDirectory(scope.userId,path,limits.maxDirectoryDepth);const item={id:crypto.randomUUID(),ownerId:scope.userId,diskSpace:scope.diskSpace,files,directories:dirs,total,batches:[],createdAt:Date.now(),collaborationId:input.collaborationId||''};save(item);return item;},()=>drive.reloadPersistence());
    },assertBatch(scope,id,files){const item=refresh(get(id,scope)),limit=settings.get(scope.userId).folderUploadMaxBytes;if(item.total>limit)throw new Error('FOLDER_UPLOAD_TOO_LARGE');const used=new Set(item.batches.filter(b=>b.completed||['running','queued'].includes(b.status)).flatMap(b=>b.keys));for(const f of files){const match=item.files.find(v=>key(v)===key(f));if(!match||match.size!==f.size||used.has(key(f)))throw new Error('FOLDER_UPLOAD_BATCH_CONFLICT');}return item;},claim(scope,id,job){return repository.atomic(()=>{const item=this.assertBatch(scope,id,job.files);item.batches.push({uploadId:job.id,operationId:job.operationId,keys:job.files.map(key),status:'queued',completed:false});save(item);});}};
}
module.exports={createFolderUploads};
