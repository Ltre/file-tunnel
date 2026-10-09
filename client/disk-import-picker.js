(function(global){
    'use strict';
    const LIMIT=100*1024*1024;
    async function plan(client,space,selected,signal){
        const directories=[],files=new Map();
        const roots=selected.filter(entry=>!selected.some(parent=>parent!==entry&&parent.kind==='directory'&&(entry.kind==='directory'?entry.path===parent.path||entry.path.startsWith(parent.path+'/'):entry.folderPath===parent.path||entry.folderPath?.startsWith(parent.path+'/'))));
        for(const item of roots){
            signal?.throwIfAborted();
            if(item.kind==='directory'){
                const tree=await client.raw('/tree?path='+encodeURIComponent(item.path),{diskSpace:space,signal});
                const prefix=item.path.split('/').slice(0,-1).join('/');
                for(const dir of tree.directories||[])directories.push({path:dir.path.slice(prefix?prefix.length+1:0)+'/',type:'application/x-directory'});
                for(const file of tree.files||[]){if(['blocked','deleted'].includes(file.reviewStatus))throw new Error('所选目录包含不可访问文件，请重新选择');files.set(file.id,{...file,path:[file.folderPath,file.name].filter(Boolean).join('/').slice(prefix?prefix.length+1:0)});}
            }else files.set(item.id,{...item,path:item.name});
        }
        const result=[...directories,...files.values()];
        if([...files.values()].some(file=>!Number.isSafeInteger(Number(file.size))||Number(file.size)<0))throw new Error('来源文件大小信息无效，请刷新网盘后重新选择');
        if([...files.values()].reduce((sum,file)=>sum+Number(file.size),0)>LIMIT)throw new Error('导入文件合计大小超过 100MB，请减少选择');
        const names=new Set();for(const entry of result){if(names.has(entry.path))throw new Error('导入项目之间存在同名路径：'+entry.path);names.add(entry.path);}
        return result;
    }
    async function choose({validate=()=>{},destination=''}={}){
        const client=global.DiskClient,controller=new AbortController();
        const dialog=document.createElement('dialog');dialog.className='disk-import-picker';
        const header=document.createElement('header'),title=document.createElement('h2');title.textContent='从网盘导入';
        const spaces=document.createElement('select');spaces.className='telegram-drive-space-picker';spaces.setAttribute('aria-label','导入来源分区');
        const close=document.createElement('button');close.className='disk-dialog-close';close.textContent='×';close.setAttribute('aria-label','取消网盘导入');
        const tree=document.createElement('main'),status=document.createElement('p');status.setAttribute('role','status');
        const footer=document.createElement('footer'),cancel=document.createElement('button'),accept=document.createElement('button');cancel.textContent='取消';accept.textContent='导入所选';footer.append(cancel,accept);
        header.append(title,spaces,close);dialog.append(header,tree,status,footer);document.body.append(dialog);dialog.showModal();
        let done=false,busy=false,space=client.getSpace(),selected=new Map(),loaded=new Map(),expanded=new Set(['']);
        return new Promise(resolve=>{
            const finish=result=>{if(done)return;done=true;controller.abort();document.removeEventListener('keydown',escapeKey,true);dialog.close();dialog.remove();resolve(result);};
            const escapeKey=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();finish(null);}};
            document.addEventListener('keydown',escapeKey,true);
            close.onclick=cancel.onclick=()=>finish(null);dialog.addEventListener('cancel',e=>{e.preventDefault();finish(null);});
            const key=item=>item.kind==='directory'?'d:'+item.path:'f:'+item.id;
            async function load(path=''){
                const requestSpace=space;
                const cache=loaded;
                if(!cache.has(path)){const data=await client.raw('/list?path='+encodeURIComponent(path),{diskSpace:requestSpace,signal:controller.signal});if(!done&&space===requestSpace&&cache===loaded)cache.set(path,data);}
                if(!done&&space===requestSpace)render();
            }
            function render(){
                tree.replaceChildren();
                function rows(path,depth){
                    const data=loaded.get(path);if(!data)return;
                    for(const item of [...(data.folders||[]),...(data.files||[])]){
                        const row=document.createElement('div');row.className='disk-import-row';row.style.paddingLeft=`${10+depth*18}px`;
                        const check=document.createElement('input');check.type='checkbox';check.checked=selected.has(key(item));check.disabled=busy||['blocked','deleted'].includes(item.reviewStatus);check.setAttribute('aria-label','选择 '+item.name);check.onchange=()=>{if(check.checked)selected.set(key(item),item);else selected.delete(key(item));status.textContent=`已选 ${selected.size} 项 · 目标：/${destination||''}`;};
                        const label=document.createElement('button');label.type='button';label.textContent=(item.kind==='directory'?(expanded.has(item.path)?'▾ 📁 ':'▸ 📁 '):'📄 ')+item.name;label.disabled=check.disabled;label.onclick=async()=>{try{if(item.kind==='directory'){if(expanded.has(item.path))expanded.delete(item.path);else{expanded.add(item.path);await load(item.path);}render();}else{check.checked=!check.checked;check.onchange();}}catch(error){status.textContent=global.DiskErrorMessages.format(error);}};
                        row.append(check,label);tree.append(row);if(item.kind==='directory'&&expanded.has(item.path))rows(item.path,depth+1);
                    }
                }
                rows('',0);
            }
            spaces.onchange=async()=>{space=spaces.value;selected=new Map();loaded=new Map();expanded=new Set(['']);status.textContent='切换分区已清空选择';try{await load();}catch(error){if(!done)status.textContent=global.DiskErrorMessages.format(error);}};
            accept.onclick=async()=>{
                if(busy||!selected.size)return;busy=true;accept.disabled=true;spaces.disabled=true;render();
                try{
                    const entries=await plan(client,space,[...selected.values()],controller.signal);if(done)return;validate(entries);
                    let received=0;const total=entries.reduce((n,file)=>n+Number(file.size||0),0);
                    for(const file of entries){
                        if(file.type==='application/x-directory'){file.data=new Uint8Array();continue;}
                        controller.signal.throwIfAborted();status.textContent=`正在导入 ${file.path} · ${received}/${total} B`;
                        const response=await fetch('/api/telegram/drive/files/'+encodeURIComponent(file.id)+'/stream?purpose=web-import&disk_space='+encodeURIComponent(space),{credentials:'same-origin',cache:'no-store',signal:controller.signal});
                        if(!response.ok){const data=await response.json().catch(()=>({}));throw Object.assign(new Error(data.error||'DISK_READ_FAILED'),data);}
                        const reader=response.body.getReader(),chunks=[];let size=0;
                        while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;received+=next.value.length;if(size>Number(file.size)||received>LIMIT){await reader.cancel();throw new Error('文件大小在导入期间发生变化，请刷新后重新选择');}chunks.push(next.value);status.textContent=`正在导入 ${file.path} · ${received}/${total} B`;}
                        if(size!==Number(file.size))throw new Error('文件未完整读取，未导入草稿。请重试');
                        file.data=new Uint8Array(size);let offset=0;for(const chunk of chunks){file.data.set(chunk,offset);offset+=chunk.length;}
                    }
                    if(!done)finish(entries);
                }catch(error){if(!done)status.textContent=global.DiskErrorMessages.format(error);}finally{busy=false;accept.disabled=false;spaces.disabled=false;if(!done)render();}
            };
            (async()=>{try{const data=await client.raw('/spaces',{signal:controller.signal});if(done)return;for(const item of data.spaces||[]){const option=document.createElement('option');option.value=item.scopeKey??item.name;option.textContent=item.name;option.disabled=Boolean(item.state&&item.state!=='ACTIVE');spaces.append(option);}spaces.value=space;status.textContent='多选文件或目录；切换分区会清空选择。可随时取消。';await load();}catch(error){if(!done)status.textContent=global.DiskErrorMessages.format(error);}})();
        });
    }
    global.DiskImportPicker={choose,_test:{plan}};
})(window);
