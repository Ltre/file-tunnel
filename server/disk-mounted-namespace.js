'use strict';
const {normalizeTelegramDrivePath:normalize}=require('./telegram-drive');
const inside=(path,root)=>!root||path===root||path.startsWith(root+'/');
function createMountedNamespace({mounts,collaborations,partitions,spaces}) {
    function resolve(ownerId,space,mountId) {
        partitions.find(ownerId,space);
        const {mount,grant}=mounts.resolve(mountId,ownerId,space);
        const partition=partitions.find(grant.ownerId,grant.diskSpace),drive=spaces.get(partition.scopeKey);drive.reloadPersistence();
        const root=normalize(grant.path||'');
        const visible=item=>item&&!['blocked','deleted'].includes(item.reviewStatus);
        const directoryRecord=path=>(drive.getDirectoryRecord || drive.getDirectory).call(drive,grant.ownerId,path);
        function ancestors(path){for(let p=path;p;p=p.split('/').slice(0,-1).join('/'))if(!visible(directoryRecord(p)))throw new Error('COLLABORATION_OUT_OF_SCOPE');}
        function file(id){const item=drive.get(grant.ownerId,id);if(!visible(item)||(grant.kind==='file'?item.id!==grant.fileId:!inside(item.folderPath||'',root)))throw new Error('COLLABORATION_OUT_OF_SCOPE');ancestors(item.folderPath||'');return {...item,viewerId:ownerId,sourceDiskSpace:grant.diskSpace,proxyMount:{ownerId,space,mountId}};}
        function directory(path){path=normalize(path);if(grant.kind!=='directory'||!inside(path,root))throw new Error('COLLABORATION_OUT_OF_SCOPE');const item=directoryRecord(path);if(!visible(item))throw new Error('DIRECTORY_NOT_FOUND');ancestors(path);return item;}
        if(grant.kind==='file')file(grant.fileId);else directory(root);
        return {mount,grant,drive,root,file,directory,assertCurrent(){const fresh=resolve(ownerId,space,mountId);if(fresh.grant.id!==grant.id||fresh.grant.grantVersion!==grant.grantVersion)throw new Error('COLLABORATION_NOT_FOUND');return fresh;}};
    }
    function locate(mapping,key) {
        const owner=String(mapping.userId),space=String(mapping.diskSpace||'');
        const found=mounts.list(owner,space).map(m=>({m,prefix:[m.parentPath,m.name].filter(Boolean).join('/')})).find(({prefix})=>key===prefix||key===prefix+'/'||key.startsWith(prefix+'/'));
        if(!found)return null;
        const ns=resolve(owner,space,found.m.id),relative=key.slice(found.prefix.length).replace(/^\//,'').replace(/\/$/,'');
        if(normalize(key.endsWith('/')?relative:relative.split('/').slice(0,-1).join('/'))!==(key.endsWith('/')?relative:relative.split('/').slice(0,-1).join('/')) || relative.split('/').some(v=>v==='.'||v==='..'))throw new Error('COLLABORATION_OUT_OF_SCOPE');
        return {...ns,prefix:found.prefix,relative};
    }
    function object(mapping,key){const ns=locate(mapping,key);if(!ns)return null;
        if(!ns.relative||key.endsWith('/')){if(ns.grant.kind==='directory')ns.directory([ns.root,ns.relative].filter(Boolean).join('/'));else if(ns.relative)throw new Error('NoSuchKey');return {kind:'marker',key,size:0,type:'application/x-directory',etag:'d41d8cd98f00b204e9800998ecf8427e',updatedAt:ns.mount.updatedAt,mounted:true};}
        const path=ns.grant.kind==='file'?'':[ns.root,ns.relative.split('/').slice(0,-1).join('/')].filter(Boolean).join('/');
        const name=ns.relative.split('/').at(-1);
        const file=ns.grant.kind==='file'?ns.file(ns.grant.fileId):ns.drive.list(ns.grant.ownerId,path).files.find(item=>item.name===name);
        if(!file||ns.grant.kind==='file'&&name!==file.name)throw new Error('NoSuchKey');
        const checked=ns.file(file.id);return {kind:'file',key,size:checked.size,type:checked.type,updatedAt:checked.updatedAt,etag:checked.contentSha256||String(checked.id)+'-'+String(checked.logicalContentVersion||checked.updatedAt),file:checked,mounted:true};
    }
    function objects(mapping) {
        const result=[];
        // Resolve once per mount. Re-resolving and reloading SQLite for every
        // descendant makes a large read-only listing unnecessarily expensive.
        for(const mount of mounts.list(String(mapping.userId),String(mapping.diskSpace||''))) {
            let ns;
            try { ns=resolve(String(mapping.userId),String(mapping.diskSpace||''),mount.id); }
            catch (_) { continue; }
            const prefix=[mount.parentPath,mount.name].filter(Boolean).join('/');
            const marker=key=>({kind:'marker',key,size:0,type:'application/x-directory',etag:'d41d8cd98f00b204e9800998ecf8427e',updatedAt:mount.updatedAt,mounted:true});
            const addFile=(item,key)=>{const file=ns.file(item.id);result.push({kind:'file',key,size:file.size,type:file.type,updatedAt:file.updatedAt||file.createdAt,etag:file.contentSha256||file.id+'-'+file.logicalContentVersion,file,mounted:true});};
            result.push(marker(prefix+'/'));
            if(ns.grant.kind==='file') { const file=ns.file(ns.grant.fileId);addFile(file,prefix+'/'+file.name);continue; }
            const tree=ns.drive.getDirectoryTree(ns.grant.ownerId,ns.root);
            if(tree.files.length+tree.directories.length>10000)throw new Error('MOUNT_LIST_TOO_LARGE');
            for(const directory of tree.directories) {
                if(directory.path===ns.root)continue;
                try { ns.directory(directory.path);result.push(marker(prefix+'/'+directory.path.slice(ns.root.length+1)+'/')); }
                catch (_) { /* Hidden/reviewed ancestors exclude their descendants. */ }
            }
            for(const file of tree.files) {
                try { addFile(file,prefix+'/'+[file.folderPath.slice(ns.root.length).replace(/^\//,''),file.name].filter(Boolean).join('/')); }
                catch (_) { /* Do not expose blocked, deleted or out-of-scope files. */ }
            }
        }
        return result;
    }
    function assertWritable(mapping,key,{tree=false}={}){const owner=String(mapping.userId),space=String(mapping.diskSpace||'');const pointers=mounts.list(owner,space);const path=key.replace(/\/$/,'');if(pointers.some(m=>{const p=[m.parentPath,m.name].filter(Boolean).join('/');return inside(path,p)||(tree&&inside(p,path));}))throw Object.assign(new Error('MOUNT_READ_ONLY'),{userMessage:'挂载协同在 S3/外部 API 中只读，不能修改、删除或移除挂载（MOUNT_READ_ONLY）'});}
    return {resolve,locate,object,objects,assertWritable};
}
module.exports={createMountedNamespace};
