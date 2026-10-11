(function(global){
    'use strict';
    const MAX=20_000_000,PAGE=32*1024,HEX_PAGE=8*1024;
    const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function bytesFromHex(text){const value=text.replace(/\s/g,'');if(value.length%2||/[^0-9a-f]/i.test(value))throw new Error('十六进制内容须由完整的两位字节组成，例如 00 7F FF');const out=new Uint8Array(value.length/2);for(let i=0;i<out.length;i++)out[i]=parseInt(value.slice(i*2,i*2+2),16);return out;}
    function markdown(text){return escape(text).replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h1>$1</h1>').replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`\n]+)`/g,'<code>$1</code>').replace(/^[-*] (.+)$/gm,'<div>• $1</div>').replace(/\n/g,'<br>');}
    function textBlob(text){const parts=[];for(let i=0;i<text.length;){let end=Math.min(text.length,i+PAGE);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;parts.push(new TextEncoder().encode(text.slice(i,end)));i=end;}return new Blob(parts);}
    async function validUtf8(blob){const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});for(let i=0;i<blob.size;i+=PAGE)decoder.decode(await blob.slice(i,i+PAGE).arrayBuffer(),{stream:true});decoder.decode();}
    // Immutable Blob slices keep backing data shared; decode only the active window.
    class Document {
        constructor(blob=new Blob([])){this.blob=blob;this.undoStack=[];this.redoStack=[];}
        replace(start,end,insert){if(start<0||end<start||end>this.blob.size)throw new Error('编辑范围已变化，请重新定位');const next=new Blob([this.blob.slice(0,start),insert,this.blob.slice(end)]);if(next.size>MAX)throw new Error('编辑内容超过 20MB');this.undoStack.push({blob:this.blob,cursor:start,cost:insert.size+end-start});while(this.undoStack.length>1&&(this.undoStack.length>50||this.undoStack.reduce((sum,item)=>sum+(item.cost||0),0)>8_000_000))this.undoStack.shift();this.redoStack=[];this.blob=next;return start+insert.size;}
        history(redo=false){const from=redo?this.redoStack:this.undoStack,to=redo?this.undoStack:this.redoStack,state=from.pop();if(!state)return null;to.push({blob:this.blob,cursor:state.cursor,cost:state.cost});this.blob=state.blob;return state.cursor;}
        async window(offset,hex=false){let start=Math.max(0,Math.min(this.blob.size,Number(offset)||0)),end=Math.min(this.blob.size,start+(hex?HEX_PAGE:PAGE));
            if(!hex){if(start<this.blob.size){const left=new Uint8Array(await this.blob.slice(Math.max(0,start-3),start+1).arrayBuffer());let pos=left.length-1;while(pos>0&&(left[pos]&0xc0)===0x80){start--;pos--;}}
                const right=new Uint8Array(await this.blob.slice(end,end+4).arrayBuffer());for(let i=0;i<right.length&&(right[i]&0xc0)===0x80;i++)end++;
                if(end<this.blob.size){const edge=new Uint8Array(await this.blob.slice(end-1,end+1).arrayBuffer());if(edge[0]===13&&edge[1]===10)end++;}}
            const bytes=new Uint8Array(await this.blob.slice(start,end).arrayBuffer()),raw=hex?Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(' '):new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
            return {start,end,raw,text:hex?raw:raw.replace(/\r\n?/g,'\n')};}
    }
    function rawIndex(raw,position){let display=0,index=0;while(index<raw.length&&display<position){if(raw[index]==='\r'&&raw[index+1]==='\n')index++;index++;display++;}return index;}
    function difference(before,after){let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;if(start&&/[\uD800-\uDBFF]/.test(before[start-1]))start--;let left=before.length,right=after.length;while(left>start&&right>start&&before[left-1]===after[right-1]){left--;right--;}if(left<before.length&&/[\uDC00-\uDFFF]/.test(before[left])){left++;right++;}return {start,left,right};}
    async function open({item,path='',openDialog,onSaved}){
        const client=global.DiskClient,context={...client.context(),...(item?.diskTransportContext||{})};
        if(item&&item.size>MAX)throw new Error('编辑器最多打开 20MB 文件；大文件仍可下载');
        const blob=item?await client.read(item):new Blob([]);if(blob.size>MAX)throw new Error('编辑器最多打开 20MB 文件');
        const doc=new Document(blob),body=document.createElement('div');body.className='disk-file-editor';
        const name=document.createElement('input');name.value=item?.name||'新建文件.txt';name.disabled=Boolean(item);name.setAttribute('aria-label','文件名称');
        const mode=document.createElement('select');mode.setAttribute('aria-label','编辑类型');for(const [value,title] of [['text','纯文本'],['markdown','Markdown'],['hex','十六进制']])mode.add(new Option(title,value));
        mode.value=/\.md$/i.test(item?.name||'')?'markdown':'text';try{await validUtf8(blob);}catch(_){mode.value='hex';}
        const panes=document.createElement('div');panes.className='disk-editor-panes';const edit=document.createElement('textarea'),preview=document.createElement('div');edit.spellcheck=false;edit.setAttribute('aria-label','文件正文');preview.className='disk-editor-preview';panes.append(edit,preview);
        const toolbar=document.createElement('div');toolbar.className='disk-editor-navigation';const state=document.createElement('p');state.setAttribute('role','status');
        const offset=document.createElement('input');offset.type='number';offset.min='0';offset.setAttribute('aria-label','定位字节位置');const range=document.createElement('span');range.className='disk-editor-range';
        let current,loading=false,saving=false,composing=false,anchor=null,previewTimer,modeValue=mode.value;
        const encode=text=>new TextEncoder().encode(text);
        const button=(text,handler)=>{const b=document.createElement('button');b.type='button';b.className='btn btn-secondary';b.textContent=text;b.onclick=()=>Promise.resolve().then(()=>{if(saving||loading||composing)throw new Error('正在处理，请稍候');return handler();}).catch(error=>{state.textContent=error.message;});toolbar.append(b);return b;};
        const updatePreview=()=>{preview.hidden=mode.value==='text';panes.classList.toggle('single',preview.hidden);if(mode.value==='markdown')preview.innerHTML=markdown(edit.value);else if(mode.value==='hex'){try{preview.textContent=new TextDecoder().decode(bytesFromHex(edit.value)).replace(/[\u0000-\u0008\u000b-\u001f]/g,'·');}catch(error){preview.textContent=error.message;}}};
        const position=(pos=edit.selectionStart)=>current.start+(mode.value==='hex'?Math.floor(edit.value.slice(0,pos).replace(/\s/g,'').length/2):encode(current.raw.slice(0,rawIndex(current.raw,pos))).length);
        const commit=()=>{if(!current||composing||edit.value===current.text)return;
            if(mode.value==='hex'){const data=bytesFromHex(edit.value);doc.replace(current.start,current.end,new Blob([data]));current.end=current.start+data.length;current.raw=current.text=edit.value;}
            else{const change=difference(current.text,edit.value),a=rawIndex(current.raw,change.start),b=rawIndex(current.raw,change.left),insert=edit.value.slice(change.start,change.right),rawInsert=current.raw.includes('\r\n')?insert.replace(/\n/g,'\r\n'):insert;
                const start=current.start+encode(current.raw.slice(0,a)).length,end=current.start+encode(current.raw.slice(0,b)).length,inserted=textBlob(rawInsert);doc.replace(start,end,inserted);current.end+=inserted.size-(end-start);current.raw=current.raw.slice(0,a)+rawInsert+current.raw.slice(b);current.text=edit.value;}
            state.textContent='尚未保存 · 撤销保留最近 50 步';anchor=null;
        };
        const load=async(where,caret='start')=>{if(loading||saving||composing)return;commit();loading=true;edit.disabled=true;try{current=await doc.window(where,mode.value==='hex');edit.value=current.text;edit.scrollTop=0;edit.setSelectionRange(caret==='end'?edit.value.length:0,caret==='end'?edit.value.length:0);offset.value=String(current.start);range.textContent=`字节 ${current.start}–${current.end} / ${doc.blob.size} · 预览仅当前段`;updatePreview();}finally{loading=false;edit.disabled=false;}};
        button('上一段',()=>load(Math.max(0,current.start-(mode.value==='hex'?HEX_PAGE:PAGE)),'end'));button('下一段',()=>load(current.end));toolbar.append(offset);button('定位',()=>{const at=Number(offset.value);if(!Number.isSafeInteger(at)||at<0||at>doc.blob.size)throw new Error(`请输入 0 至 ${doc.blob.size} 的整数字节位置`);return load(at);});
        const history=async redo=>{if(loading||composing||saving)return;try{commit();}catch(error){edit.value=current.text;updatePreview();state.textContent='已撤销尚未生效的输入：'+error.message;return;}const at=doc.history(redo);if(at!==null){current=null;anchor=null;await load(at);state.textContent='尚未保存';}};
        button('撤销',()=>history(false));button('重做',()=>history(true));
        button('记住选区起点',()=>{commit();anchor=position();state.textContent=`选区起点：字节 ${anchor}；切换到结束位置后点击“复制到此光标”`;});
        button('复制到此光标',async()=>{commit();if(anchor===null)throw new Error('请先记住选区起点');const at=position(),selected=doc.blob.slice(Math.min(anchor,at),Math.max(anchor,at));
            if(mode.value==='hex'){if(selected.size>1_000_000)throw new Error('十六进制跨段复制最多 1MB，请缩小选区');await navigator.clipboard.writeText(Array.from(new Uint8Array(await selected.arrayBuffer()),b=>b.toString(16).padStart(2,'0')).join(' '));}
            else await navigator.clipboard.writeText(await selected.text());state.textContent=`已复制 ${selected.size} 字节；可定位到其它段粘贴`;});
        body.append(name,mode,toolbar,range,panes,state);
        edit.addEventListener('compositionstart',()=>{composing=true;});edit.addEventListener('compositionend',()=>{composing=false;try{commit();updatePreview();}catch(error){state.textContent=error.message;}});
        edit.oninput=()=>{if(composing)return;try{commit();clearTimeout(previewTimer);previewTimer=setTimeout(updatePreview,100);}catch(error){state.textContent=error.message;}};
        edit.onpaste=event=>{if(mode.value==='hex'||composing)return;event.preventDefault();try{commit();const text=event.clipboardData.getData('text/plain'),start=position(),end=position(edit.selectionEnd),raw=current.raw.includes('\r\n')?text.replace(/\r\n?/g,'\n').replace(/\n/g,'\r\n'):text.replace(/\r\n?/g,'\n');doc.replace(start,end,textBlob(raw));current=null;anchor=null;load(start).catch(error=>{state.textContent=error.message;});state.textContent='尚未保存';}catch(error){state.textContent=error.message;}};
        edit.onkeydown=event=>{if(composing||event.isComposing)return;if((event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase())){event.preventDefault();history(event.key.toLowerCase()==='y'||event.shiftKey).catch(error=>{state.textContent=error.message;});}
            else if(event.ctrlKey&&['PageDown','PageUp'].includes(event.key)){event.preventDefault();load(event.key==='PageDown'?current.end:Math.max(0,current.start-(mode.value==='hex'?HEX_PAGE:PAGE))).catch(error=>{state.textContent=error.message;});}};
        mode.onchange=async()=>{const next=mode.value,before=modeValue;mode.value=before;if(loading||saving||composing)return;try{commit();loading=true;edit.disabled=mode.disabled=true;if(next!=='hex'){state.textContent='正在验证 UTF-8…';await validUtf8(doc.blob);}mode.value=modeValue=next;loading=false;await load(current.start);state.textContent='尚未保存 · 预览仅当前段';}catch(error){mode.value=modeValue=before;state.textContent=error.message;}finally{loading=false;edit.disabled=mode.disabled=false;}};
        let styledCard,cardStyle,overlayStyle;
        const viewport=()=>{const height=Math.min(innerHeight,global.visualViewport?.height||innerHeight);body.style.setProperty('--disk-editor-viewport',`${height}px`);
            const card=body.closest('.telegram-drive-dialog-card');if(!card)return;
            if(!styledCard){styledCard=card;cardStyle={height:card.style.height,maxHeight:card.style.maxHeight};overlayStyle={alignItems:card.parentElement.style.alignItems,paddingTop:card.parentElement.style.paddingTop};}
            card.style.height=Math.min(820,Math.max(140,height-24))+'px';card.style.maxHeight=Math.max(140,height-24)+'px';
            card.parentElement.style.alignItems='flex-start';card.parentElement.style.paddingTop=((global.visualViewport?.offsetTop||0)+12)+'px';};
        viewport();global.visualViewport?.addEventListener('resize',viewport);global.visualViewport?.addEventListener('scroll',viewport);global.addEventListener('resize',viewport);
        let result;try{await load(0);state.textContent=blob.size>PAGE?'按需分段编辑；跨段复制可使用选区起点按钮':'尚未保存';const pending=openDialog({title:item?'编辑文件：'+item.name:'新建文件',body,confirmText:'保存',canDismiss:()=>!saving,validate:async()=>{
            if(loading||composing)throw new Error('正在载入或输入，请稍候');commit();const data=doc.blob;
            const type=mode.value==='markdown'?'text/markdown;charset=utf-8':mode.value==='hex'?(item?.type||'application/octet-stream'):'text/plain;charset=utf-8';
            const route=item?'/files/'+encodeURIComponent(item.id)+'/content':'/files/content?folderPath='+encodeURIComponent(path)+'&name='+encodeURIComponent(name.value);
            state.textContent='正在保存新内容…';saving=true;edit.disabled=mode.disabled=name.disabled=true;try{const response=await client.raw(route,{...context,method:item?'PUT':'POST',headers:{'X-Disk-File-Size':String(data.size),'X-Disk-File-Type':type,'X-Disk-Expected-Version':String(item?.logicalContentVersion||0)},body:data});
            const saved=response.operation_id?await client.wait(response.operation_id,context):response;return {saved,name:name.value};}finally{saving=false;edit.disabled=mode.disabled=false;name.disabled=Boolean(item);}
        }});viewport();result=await pending;}finally{clearTimeout(previewTimer);global.visualViewport?.removeEventListener('resize',viewport);global.visualViewport?.removeEventListener('scroll',viewport);global.removeEventListener('resize',viewport);if(styledCard){Object.assign(styledCard.style,cardStyle);Object.assign(styledCard.parentElement.style,overlayStyle);}doc.undoStack=[];doc.redoStack=[];}
        if(result)await onSaved?.(result);
    }
    global.DiskFileEditor={open,_test:{bytesFromHex,markdown,Document,validUtf8,difference,rawIndex,textBlob,PAGE,HEX_PAGE}};
})(window);
