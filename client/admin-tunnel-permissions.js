(function(global){
    'use strict';
    const t=value=>global.TunnelI18n?.t(value)||value;
    async function json(url,options){const response=await fetch(url,options);if(!response.ok)throw Error((await response.json().catch(()=>({}))).error||'HTTP_'+response.status);return response.json();}
    async function init(){
        const select=document.getElementById('accessTunnelSelect'),input=document.getElementById('accessTunnelId'),button=document.getElementById('loadTunnelAccessBtn'),status=document.getElementById('tunnelAccessStatus'),container=document.getElementById('tunnelAccessEditor');
        let sessionId,request=0;
        async function load(){
            const target=String(input.value||select.value).trim(),version=++request;button.disabled=true;status.textContent=t('正在读取隧道权限...');
            try{const payload=await json('/api/sessions/'+encodeURIComponent(target)+'/access');if(version!==request)return;sessionId=target;
                global.TunnelAccessEditor.reset(container);global.TunnelAccessEditor.mount(container,{...payload,editable:true,onSave:async data=>{await json('/api/sessions/'+encodeURIComponent(target)+'/access',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});},onSaved:()=>load()});
                status.textContent=t('隧道 ID')+'：'+target+' · '+t('创建者设备')+'：'+(payload.ownerDeviceId||'—');
            }catch(error){status.textContent=t('权限读取失败')+' ['+error.message+']';}finally{if(version===request)button.disabled=false;}
        }
        button.onclick=load;select.onchange=()=>{input.value='';};
        try{const result=await json('/api/sessions'),sessions=Array.isArray(result)?result:result.sessions||[];for(const session of sessions){if(session.isDeleted)continue;const option=document.createElement('option');option.value=session.id;option.textContent=(session.shortCode||session.id)+' · '+(session.remark||'');select.append(option);}
            const desired=new URLSearchParams(location.search).get('session');if(desired)input.value=desired;if(desired||select.value)await load();else status.textContent=t('请选择隧道或输入隧道 ID');
        }catch(error){status.textContent=t('权限读取失败')+' ['+error.message+']';}
    }
    document.addEventListener('DOMContentLoaded',init);
})(window);
