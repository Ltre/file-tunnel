(function(global){
    'use strict';
    let active;
    async function open({space='',spaceName='默认分区',onRestored}){
        active?.();
        const overlay=document.createElement('dialog');overlay.className='disk-trash-overlay';overlay.setAttribute('aria-label','回收站');
        const header=document.createElement('header'),title=document.createElement('h2');title.textContent=`回收站 · ${spaceName}`;
        const close=document.createElement('button');close.textContent='×';close.className='disk-dialog-close';close.setAttribute('aria-label','关闭回收站');
        const nav=document.createElement('nav'),body=document.createElement('main'),status=document.createElement('p');status.className='disk-trash-status';status.setAttribute('role','status');
        header.append(title,close);overlay.append(header,nav,body,status);document.body.append(overlay);overlay.showModal();
        let closed=false,loading=false;
        const finish=()=>{if(closed)return;closed=true;overlay.close();overlay.remove();document.removeEventListener('keydown',key,true);if(active===finish)active=null;};
        const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();finish();}};
        document.addEventListener('keydown',key,true);overlay.addEventListener('cancel',e=>{e.preventDefault();finish();});close.onclick=finish;active=finish;
        const request=(url,options={})=>global.DiskClient.raw(url,{...options,diskSpace:space});
        const button=(text,action)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=action;return b;};
        async function load(item=null,path=''){
            if(loading||closed)return;loading=true;status.textContent='正在加载回收站…';
            try{
                const result=await request(item?`/trash/${encodeURIComponent(item.id)}?path=${encodeURIComponent(path)}`:'/trash');
                if(closed)return;body.replaceChildren();nav.replaceChildren();status.textContent=item?'可逐层查看；请返回回收站顶级列表还原整项。':'删除的正文会保留至永久删除；已在旧版本永久删除的内容不能还原。';
                nav.append(button('回收站',()=>load()));
                if(item){const parts=path.slice(item.path.length).split('/').filter(Boolean);nav.append(button(item.name,()=>load(item,item.path)));let current=item.path;for(const part of parts){current+='/'+part;const next=current;nav.append(button(part,()=>load(item,next)));}}
                const items=item?[...(result.folders||[]),...(result.files||[])]:result.items||[];
                if(!items.length){const p=document.createElement('p');p.textContent='没有项目';body.append(p);}
                for(const entry of items){
                    const row=document.createElement('div');row.className='disk-trash-row';
                    const label=button(`${entry.kind==='directory'?'📁':'📄'} ${entry.name}`,()=>{if(entry.kind==='directory')load(item||entry,entry.path);});label.className='disk-trash-entry';if(entry.kind!=='directory')label.disabled=true;
                    const info=document.createElement('small');info.textContent=item?`${entry.size||0} B`:`原位置：/${entry.originalParent||''} · ${new Date(entry.deletedAt).toLocaleString()} · ${entry.fileCount} 个文件`;
                    label.append(document.createElement('br'),info);row.append(label);
                    if(!item){
                        const restore=button('还原',async()=>{if(loading)return;loading=true;restore.disabled=true;status.textContent='正在检查原目录和名称冲突…';try{const data=await request(`/trash/${entry.id}/restore`,global.DiskClient.json('POST',{}));finish();await onRestored(data.restored);}catch(error){status.textContent=global.DiskErrorMessages.format(error);}finally{loading=false;restore.disabled=false;}});
                        const purge=button('永久删除',async()=>{if(loading||!confirm(`永久删除“${entry.name}”？此操作无法还原，未被其它文件引用的正文将进入清理。`))return;loading=true;purge.disabled=true;try{const result=await request(`/trash/${entry.id}?permanent=true`,{method:'DELETE'});loading=false;await load();if(!closed&&result.remoteCleanup?.status==='pending')status.textContent='回收站项目已永久删除；无其它引用的正文清理尚未完成，服务端将继续重试。';}catch(error){status.textContent=global.DiskErrorMessages.format(error);}finally{loading=false;purge.disabled=false;}});purge.className='disk-trash-purge';row.append(restore,purge);
                    }
                    body.append(row);
                }
            }catch(error){if(!closed)status.textContent=global.DiskErrorMessages.format(error);}finally{loading=false;}
        }
        await load();
    }
    global.DiskTrashUI={open};
})(window);
