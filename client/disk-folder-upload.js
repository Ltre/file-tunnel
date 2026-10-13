(function(global){
    'use strict';
    async function enumerate(transfer){
        const directories=[],files=[];let nodes=0;
        async function visit(entry,parent=''){
            if(++nodes>10000)throw new Error('单次目录上传最多 10000 个文件/目录');
            const path=[parent,entry.name].filter(Boolean).join('/');
            if(entry.isDirectory){directories.push(path);const reader=entry.createReader();while(true){const batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));if(!batch.length)break;for(const child of batch)await visit(child,path);}}
            else if(entry.isFile){const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));files.push({file,path});}
            else throw new Error('来源包含无法读取的项目：'+path);
        }
        const entries=Array.from(transfer.items||[]).filter(item=>item.kind==='file').map(item=>item.webkitGetAsEntry?.());
        if(!entries.some(entry=>entry?.isDirectory)){
            if(entries.some(entry=>!entry)&&!transfer.files?.length)throw new Error('浏览器无法读取所选文件夹，请改用支持目录上传的浏览器');
            return null;
        }
        if(entries.some(entry=>!entry))throw new Error('浏览器无法完整读取所选目录，请改用支持目录上传的浏览器');
        for(const entry of entries)await visit(entry);return {directories,files};
    }
    async function upload(plan,destination,context=global.DiskClient.context()){
        const client=global.DiskClient,limits=(await client.raw('/limits',context)).settings,total=plan.files.reduce((n,item)=>n+item.file.size,0);
        if(total>limits.folderUploadMaxBytes)throw new Error('来源文件夹合计大小超过设置上限：'+limits.folderUploadMaxBytes+' B');
        const full=path=>[destination,path].filter(Boolean).join('/');
        if(plan.directories.some(path=>full(path).split('/').length>limits.maxDirectoryDepth))throw new Error('上传后目录层级超过 '+limits.maxDirectoryDepth+' 层');
        if(!confirm(`将上传 ${plan.files.length} 个文件、${plan.directories.length} 个目录（${total} B）到 /${destination}。确认继续？`))return;
        let files=plan.files.map(({file,path})=>{const copy=new File([file],file.name,{type:file.type,lastModified:file.lastModified});copy.diskFolderPath=full(path.split('/').slice(0,-1).join('/'));return copy;});
        if(global.DiskUploadNames)files=await global.DiskUploadNames.prepare(files,destination,text=>confirm(text));
        if(!files)return;
        const manifest={directories:plan.directories.map(full),files:files.map(f=>({name:f.name,folderPath:f.diskFolderPath,size:f.size,type:f.type}))};
        const storageKey='disk-folder-upload-resume',signature=JSON.stringify({context,destination,manifest});
        let remembered=[],parent;
        try{remembered=JSON.parse(localStorage.getItem(storageKey)||'[]');}catch(_){}
        const previous=remembered.find(item=>item.signature===signature);
        if(previous)try{parent=await client.raw('/folder-uploads/'+encodeURIComponent(previous.id),context);}catch(error){if(error.status!==404)throw error;}
        if(parent){
            if(parent.batches.some(batch=>['queued','running'].includes(batch.status)))throw new Error('之前的目录上传仍在执行，请先查看任务状态，不能重复提交。');
            if(!confirm('找到这批目录的中断记录。继续上传未完成文件？已完成内容保留，不覆盖；请确认仍选择同一批来源。'))return;
        }else{
            parent=await client.raw('/folder-uploads',{...context,...client.json('POST',manifest)});
            remembered=remembered.filter(item=>item.signature!==signature).concat({signature,id:parent.id}).slice(-20);
            try{localStorage.setItem(storageKey,JSON.stringify(remembered));}catch(_){}
        }
        const completedKeys=new Set(parent.batches.filter(batch=>batch.completed).flatMap(batch=>batch.keys));
        const remaining=files.filter(file=>!completedKeys.has([file.diskFolderPath,file.name].join('/')));
        let completed=files.length-remaining.length;
        for(let i=0;i<remaining.length;i+=100){const batch=remaining.slice(i,i+100);while(true){try{await client.upload(batch,destination,f=>f,{folderUploadId:parent.id,transportContext:context});completed+=batch.length;break;}catch(error){if(!confirm(`已完成 ${completed}/${files.length} 个文件。本批失败：${global.DiskErrorMessages?.format(error)||error.message}。重试本批？取消将保留已完成文件和目录；再次拖入相同来源可继续。`))throw error;}}}
        try{localStorage.setItem(storageKey,JSON.stringify(remembered.filter(item=>item.id!==parent.id)));}catch(_){}
        return {completed,directoryCount:plan.directories.length};
    }
    global.DiskFolderUpload={enumerate,upload};
})(window);
