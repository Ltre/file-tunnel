'use strict';
const crypto=require('node:crypto');
const {diskOperationError}=require('./disk-errors');
function createDiskTrash({repository,spaces,mounts,maxDepth,onMountRemoved=()=>{},assertWritable=()=>{}}) {
    const list=(user,space)=>repository.load('trash_items',space).filter(item=>item.ownerId===String(user));
    const save=(space,items)=>repository.replace('trash_items',items,item=>item.id,space);
    function find(user,space,id){const item=list(user,space).find(item=>item.id===id);if(!item)throw new Error('TRASH_NOT_FOUND');return item;}
    function archive(user,space,selection,hooks={}){
        const drive=spaces.get(space);
        return repository.atomic(()=>{
            drive.reloadPersistence();
            hooks.before?.(drive);
            assertWritable(user,space,selection,drive);
            const root=selection.kind==='directory'?drive.getDirectory(user,selection.path):drive.get(user,selection.id);
            if(!root)throw new Error('FILE_NOT_FOUND');
            if(selection.kind==='directory')drive.assertDirectoryWritable(user,selection.path);
            const originalName=root.name || root.path?.split('/').pop(), id=crypto.randomUUID(), path=selection.kind==='directory'?root.path:root.folderPath||'';
            const snapshot=drive.moveToTrash(user,id,selection);
            const savedMounts=selection.kind==='directory'?repository.load('collaboration_mounts').filter(m=>m.ownerId===String(user)&&m.diskSpace===space&&(m.parentPath===path||m.parentPath.startsWith(path+'/'))):[];
            if(savedMounts.length){mounts.removeTree(user,space,path);for(const mount of savedMounts)onMountRemoved(user,space,mount.id);}
            const item={id,ownerId:String(user),diskSpace:space,kind:selection.kind,name:originalName,path,
                originalParent:selection.kind==='directory'?path.split('/').slice(0,-1).join('/'):path,
                deletedAt:Date.now(),snapshot,mounts:savedMounts};
            save(space,[...repository.load('trash_items',space),item]);const result=summary(item);hooks.after?.(result);return result;
        },()=>{drive.reloadPersistence();mounts.reloadPersistence();});
    }
    function restore(user,space,id){
        const drive=spaces.get(space);
        return repository.atomic(()=>{
            drive.reloadPersistence();const item=find(user,space,id),{snapshot}=item;
            const originalParent=summary(item).originalParent;
            assertWritable(user,space,{kind:'restore',path:originalParent,snapshot},drive);
            const segments=originalParent.split('/').filter(Boolean),parents=segments.length?segments.map((_,i)=>segments.slice(0,i+1).join('/')):[''];
            for(const path of parents){
                const ancestor=drive.getDirectory(user,path);
                if(!ancestor){const blocked=drive.adminFiles().some(file=>file.ownerId===String(user)&&[file.folderPath,file.name].filter(Boolean).join('/')===path);throw diskOperationError('TRASH_PARENT_MISSING',blocked?'PATH_BLOCKED_BY_FILE':'TRASH_PARENT_MISSING',{targetPath:path});}
                if(['blocked','deleted'].includes(ancestor.reviewStatus))throw diskOperationError('TRASH_PARENT_MISSING','TRASH_PARENT_BLOCKED',{targetPath:path});
            }
            for(const directory of snapshot.directories){
                if(drive.getDirectory(user,directory.path)||drive.adminFiles().some(f=>f.ownerId===String(user)&&[f.folderPath,f.name].filter(Boolean).join('/')===directory.path))throw diskOperationError('TRASH_RESTORE_CONFLICT','TRASH_RESTORE_CONFLICT');
                mounts.assertNameFree(user,space,directory.path.split('/').slice(0,-1).join('/'),directory.path.split('/').pop());
            }
            for(const file of snapshot.files){
                if(file.reviewStatus==='deleted')throw new Error('TRASH_CONTENT_UNAVAILABLE');
                if(drive.adminFiles().some(f=>f.ownerId===String(user)&&f.folderPath===file.folderPath&&f.name===file.name)||drive.getDirectory(user,[file.folderPath,file.name].filter(Boolean).join('/')))throw diskOperationError('TRASH_RESTORE_CONFLICT','TRASH_RESTORE_CONFLICT');
                mounts.assertNameFree(user,space,file.folderPath||'',file.name);
                if(file.contentId&&repository.content.resolve(file.contentId)?.state!=='READY')throw new Error('TRASH_CONTENT_UNAVAILABLE');
            }
            drive.restoreTrash(user,id,snapshot,maxDepth(user));
            if(item.mounts?.length)mounts.restoreTree(user,space,item.mounts,drive);
            save(space,repository.load('trash_items',space).filter(entry=>entry.id!==id));
            return {kind:item.kind,path:item.path,parentPath:originalParent,folderPath:originalParent,id:item.kind==='file'?snapshot.files[0].id:'',name:summary(item).name};
        },()=>{drive.reloadPersistence();mounts.reloadPersistence();});
    }
    function purge(user,space,id){const drive=spaces.get(space);return repository.atomic(()=>{
        find(user,space,id);drive.reloadPersistence();const ids=drive.purgeTrash(user,id);save(space,repository.load('trash_items',space).filter(item=>item.id!==id));return ids;
    },()=>drive.reloadPersistence());}
    function summary(item){
        const original=item.kind==='file'?item.snapshot.files[0]:null;
        const name=original?.name || (String(item.name||'').startsWith(':recycle:')?'原名称信息缺失':item.name);
        const originalParent=original?.folderPath??item.originalParent;
        return {id:item.id,kind:item.kind,name,path:item.kind==='file'?originalParent:item.path,originalParent,
            originalPath:item.kind==='directory'?item.path:[originalParent,name].filter(Boolean).join('/'),
            type:original?.type||'application/x-directory',deletedAt:item.deletedAt,fileCount:item.snapshot.files.length,
            size:item.snapshot.files.reduce((n,f)=>n+(Number(f.size)||0),0)};
    }
    function contents(user,space,id,path=''){
        const item=find(user,space,id),root=item.kind==='directory'?item.path:'';
        if(item.kind!=='directory'||path!==root&&!path.startsWith(root+'/'))throw new Error('TRASH_PATH_INVALID');
        if(!item.snapshot.directories.some(d=>d.path===path))throw new Error('DIRECTORY_NOT_FOUND');
        return {root,path,deletedAt:item.deletedAt,folders:item.snapshot.directories.filter(d=>d.path!==path&&d.path.split('/').slice(0,-1).join('/')===path).map(d=>({kind:'directory',name:d.path.split('/').pop(),path:d.path,originalPath:d.path,type:'application/x-directory',deletedAt:item.deletedAt,size:item.snapshot.files.filter(f=>f.folderPath===d.path||f.folderPath.startsWith(d.path+'/')).reduce((n,f)=>n+(Number(f.size)||0),0)})),files:item.snapshot.files.filter(f=>f.folderPath===path).map(f=>({kind:'file',id:f.id,name:f.name,size:f.size,type:f.type,originalPath:[f.folderPath,f.name].filter(Boolean).join('/'),deletedAt:item.deletedAt}))};
    }
    return {list:(user,space)=>list(user,space).map(summary),archive,restore,purge,contents};
}
module.exports={createDiskTrash};
