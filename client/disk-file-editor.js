(function(global){
    'use strict';
    const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function bytesFromHex(text){const value=text.replace(/\s/g,'');if(value.length%2||/[^0-9a-f]/i.test(value))throw new Error('十六进制内容须由完整的两位字节组成，例如 00 7F FF');return Uint8Array.from(value.match(/../g)||[],pair=>parseInt(pair,16));}
    function markdown(text){return escape(text).replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h1>$1</h1>').replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`\n]+)`/g,'<code>$1</code>').replace(/^[-*] (.+)$/gm,'<div>• $1</div>').replace(/\n/g,'<br>');}
    async function open({item,path='',openDialog,onSaved}){
        const client=global.DiskClient,context=client.context(),MAX=20_000_000;
        if(item&&item.size>MAX)throw new Error('编辑器最多打开 20MB 文件；大文件仍可下载');
        const body=document.createElement('div');body.className='disk-file-editor';
        const name=document.createElement('input');name.value=item?.name||'新建文件.txt';name.disabled=Boolean(item);name.setAttribute('aria-label','文件名称');
        const mode=document.createElement('select');mode.setAttribute('aria-label','编辑类型');for(const [value,title] of [['text','纯文本'],['markdown','Markdown'],['hex','十六进制']])mode.add(new Option(title,value));
        mode.value=/\.md$/i.test(item?.name||'')?'markdown':'text';
        const panes=document.createElement('div');panes.className='disk-editor-panes';const edit=document.createElement('textarea'),preview=document.createElement('div');edit.spellcheck=false;edit.setAttribute('aria-label','文件正文');preview.className='disk-editor-preview';panes.append(edit,preview);
        const state=document.createElement('p');state.setAttribute('role','status');body.append(name,mode,panes,state);
        let original=new Uint8Array(),currentMode=mode.value;
        if(item){original=new Uint8Array(await (await client.read(item)).arrayBuffer());try{edit.value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(original);}catch(_){mode.value=currentMode='hex';edit.value=Array.from(original,b=>b.toString(16).padStart(2,'0')).join(' ');}}
        const bytes=()=>mode.value==='hex'?bytesFromHex(edit.value):new TextEncoder().encode(edit.value);
        const render=()=>{preview.hidden=mode.value==='text';panes.classList.toggle('single',preview.hidden);state.textContent='尚未保存';if(mode.value==='markdown')preview.innerHTML=markdown(edit.value);else if(mode.value==='hex'){try{preview.textContent=new TextDecoder().decode(bytes()).replace(/[\u0000-\u0008\u000b-\u001f]/g,'·');}catch(error){preview.textContent=error.message;}}};
        edit.oninput=render;mode.onchange=()=>{try{const previous=currentMode==='hex'?bytesFromHex(edit.value):new TextEncoder().encode(edit.value);edit.value=mode.value==='hex'?Array.from(previous,b=>b.toString(16).padStart(2,'0')).join(' '):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(previous);currentMode=mode.value;render();}catch(error){mode.value=currentMode;state.textContent=error.message;}};render();
        const result=await openDialog({title:item?'编辑文件：'+item.name:'新建文件',body,confirmText:'保存',validate:async()=>{
            const data=bytes();if(data.length>MAX)throw new Error('编辑内容超过 20MB');
            const type=mode.value==='markdown'?'text/markdown;charset=utf-8':mode.value==='hex'?(item?.type||'application/octet-stream'):'text/plain;charset=utf-8';
            const route=item?'/files/'+encodeURIComponent(item.id)+'/content':'/files/content?folderPath='+encodeURIComponent(path)+'&name='+encodeURIComponent(name.value);
            state.textContent='正在保存新内容…';const response=await client.raw(route,{...context,method:item?'PUT':'POST',headers:{'X-Disk-File-Size':String(data.length),'X-Disk-File-Type':type,'X-Disk-Expected-Version':String(item?.logicalContentVersion||0)},body:new Blob([data],{type})});
            const saved=response.operation_id?await client.wait(response.operation_id,context):response;return {saved,name:name.value};
        }});
        if(result)await onSaved?.(result);
    }
    global.DiskFileEditor={open,_test:{bytesFromHex,markdown}};
})(window);
