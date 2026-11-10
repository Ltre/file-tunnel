(function(global){
    'use strict';
    const t=value=>global.TunnelI18n?.t(value)||value;
    async function json(url,options){
        const response=await fetch(url,options);
        if(!response.ok)throw Error((await response.json().catch(()=>({}))).error||'HTTP_'+response.status);
        return response.json();
    }
    async function init(){
        const select=document.getElementById('accessTunnelSelect'),input=document.getElementById('accessTunnelId');
        const status=document.getElementById('tunnelAccessStatus'),missing=document.getElementById('tunnelAccessMissing');
        const picker=document.getElementById('accessDevicePicker'),manual=document.getElementById('accessDeviceId'),list=document.getElementById('accessDeviceList');
        const deviceStatus=document.getElementById('deviceAccessStatus'),container=document.getElementById('tunnelAccessEditor');
        const helpButton=document.getElementById('tunnelAccessHelpBtn'),help=document.getElementById('tunnelAccessHelp');
        function showHelp(value){help.hidden=!value;helpButton.setAttribute('aria-expanded',String(value));}
        helpButton.onclick=()=>showHelp(help.hidden);
        document.addEventListener('click',event=>{if(!helpButton.contains(event.target)&&!help.contains(event.target))showHelp(false);});
        document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!help.hidden){showHelp(false);helpButton.focus();}});
        const drafts=new Map();
        let sessionId='',deviceId='',tunnelRequest=0,deviceRequest=0,tunnelAbort,deviceAbort,saving=false,tunnelPayload;
        function selection(node,active){node.classList.toggle('is-selected',active);}
        function clearEditor(keepSpace=false){
            const height=keepSpace?container.getBoundingClientRect().height:0;
            container.style.minHeight=height?`${height}px`:'';
            global.TunnelAccessEditor.reset(container);
            container.replaceChildren();
        }
        function setSaving(value){saving=value;for(const control of document.querySelectorAll('.tunnel-access-picker input,.tunnel-access-picker select,.tunnel-access-devices textarea,.tunnel-access-device'))control.disabled=value;select.disabled=value||input.classList.contains('is-selected');}
        function renderDevices(payload){
            const roles=new Map((payload.adminDevices||[]).map(record=>[record.deviceId,'designated-administrator']));
            for(const record of payload.managementDevices||[])roles.set(record.deviceId,'administrator');roles.set(payload.ownerDeviceId,'owner');
            const priority=value=>value==='owner'?2:value?1:0;
            const devices=(payload.knownDevices||[]).map(device=>({...device,role:roles.get(device.deviceId)||device.role||''})).sort((a,b)=>priority(b.role)-priority(a.role)||Number(b.online)-Number(a.online));
            list.replaceChildren();
            for(const device of devices){
                const button=document.createElement('button');button.type='button';button.className='tunnel-access-device '+(device.online?'is-online':'is-offline');button.dataset.deviceId=device.deviceId;
                const selected=!manual.classList.contains('is-selected')&&deviceId===device.deviceId;selection(button,selected);button.setAttribute('aria-pressed',String(selected));
                const heading=document.createElement('strong'),name=document.createElement('span'),id=document.createElement('small'),presence=document.createElement('span');name.className='tunnel-access-device-name';
                name.textContent=device.deviceName||device.deviceId;heading.append(name);
                if(device.role){const badge=document.createElement('span');badge.className='tunnel-access-device-role';badge.textContent=t(device.role==='owner'?'创建者':'管理员');badge.title=t(device.role==='owner'?'创建者':device.role==='designated-administrator'?'指定设备管理员':'设为隧道管理员（全部权限及分配权限）');heading.append(badge);}
                id.textContent=device.deviceId;presence.textContent=t(device.online?'在线':'离线');button.append(heading,id,presence);button.title=device.deviceName||device.deviceId;
                button.onclick=()=>{manual.value='';selectDevice(device.deviceId,false);};list.append(button);
            }
        }
        function mount(payload,key){
            const target=sessionId,selected=deviceId,draft=drafts.get(key);
            global.TunnelAccessEditor.mount(container,{...payload,draft:draft?.version===payload.version?draft:null,
                onChange:value=>drafts.set(key,value),
                onSave:async data=>{
                    setSaving(true);
                    try{return await json('/api/sessions/'+encodeURIComponent(target)+'/access/devices/'+encodeURIComponent(selected),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});}
                    finally{setSaving(false);}
                },
                onSaved:value=>{drafts.delete(key);if(sessionId===target&&deviceId===selected){
                    tunnelPayload.managementDevices=(tunnelPayload.managementDevices||[]).filter(record=>record.deviceId!==selected);
                    const known=tunnelPayload.knownDevices.find(record=>record.deviceId===selected);if(known)known.role='';
                    if(value.mode==='administrator')tunnelPayload.managementDevices.push({deviceId:selected});
                    renderDevices(tunnelPayload);mount(value,key);deviceStatus.textContent=t('设备权限已保存');
                }}
            });
        }
        async function selectDevice(target,isManual){
            if(saving)return;
            target=String(target||'').trim();
            selection(manual,isManual);for(const button of list.children){const active=!isManual&&button.dataset.deviceId===target;selection(button,active);button.setAttribute('aria-pressed',String(active));}
            if(target===deviceId)return;
            deviceId=target;const version=++deviceRequest,scope=sessionId,key=scope+'\n'+target;
            deviceAbort?.abort();deviceAbort=new AbortController();clearEditor(Boolean(target));
            deviceStatus.textContent=target?t('正在验证设备并读取权限...'):t('请选择设备或输入有效设备 ID');
            if(!target)return;
            try{
                const payload=await json('/api/sessions/'+encodeURIComponent(scope)+'/access/devices/'+encodeURIComponent(target),{signal:deviceAbort.signal});
                if(version!==deviceRequest||scope!==sessionId)return;
                mount(payload,key);deviceStatus.textContent='';
                container.style.minHeight='';
                const bounds=container.getBoundingClientRect();
                const viewportHeight=document.documentElement.clientHeight;
                const visibleHeight=Math.max(0,Math.min(bounds.bottom,viewportHeight)-Math.max(bounds.top,0));
                if(visibleHeight<=Math.min(bounds.height,viewportHeight)/2){
                    container.scrollIntoView({block:'start',behavior:'smooth'});
                }
            }catch(error){
                if(version!==deviceRequest||scope!==sessionId||error.name==='AbortError')return;
                clearEditor();
                deviceStatus.textContent=t(error.message==='device-not-found'?'当前选中设备不存在，请重新指定':error.message==='invalid-device'?'请选择设备或输入有效设备 ID':'权限读取失败')+(error.message==='device-not-found'||error.message==='invalid-device'?'':' ['+error.message+']');
                deviceId='';
            }
        }
        async function loadTunnel(target,isManual){
            if(saving)return;
            target=String(target||'').trim();
            const listed=[...select.options].some(option=>option.value===target);
            isManual=Boolean(target&&isManual&&!listed);
            if(listed){select.value=target;input.value='';}
            selection(input,isManual);select.disabled=isManual;
            sessionId=target;deviceId='';++deviceRequest;deviceAbort?.abort();tunnelAbort?.abort();tunnelAbort=new AbortController();
            const version=++tunnelRequest;clearEditor();list.replaceChildren();manual.value='';selection(manual,false);picker.hidden=true;missing.hidden=true;deviceStatus.textContent='';
            status.textContent=target?t('正在读取隧道权限...'):t('请选择隧道或输入隧道 ID');
            if(!target)return;
            try{
                const payload=await json('/api/sessions/'+encodeURIComponent(target)+'/access',{signal:tunnelAbort.signal});
                if(version!==tunnelRequest)return;
                tunnelPayload=payload;renderDevices(payload);
                picker.hidden=false;status.textContent=t('隧道 ID')+'：'+target+' · '+t('创建者设备')+'：'+(payload.ownerDeviceId||'—');deviceStatus.textContent=t('请选择设备以查看隧道权限');
            }catch(error){
                if(version!==tunnelRequest||error.name==='AbortError')return;
                if(error.message==='session-not-found'){missing.hidden=false;status.textContent='';}
                else status.textContent=t('权限读取失败')+' ['+error.message+']';
            }
        }
        select.onchange=()=>{input.value='';loadTunnel(select.value,false);};input.onblur=()=>{if(input.value.trim()||input.classList.contains('is-selected'))loadTunnel(input.value,true);};
        manual.onblur=()=>{if(manual.value.trim()||manual.classList.contains('is-selected'))selectDevice(manual.value,true);};
        for(const field of [input,manual])field.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();field.blur();}};
        try{
            const result=await json('/api/sessions'),sessions=(Array.isArray(result)?result:result.sessions||[]).filter(value=>!value.isDeleted).sort((a,b)=>(Number(b.lastActivity)||0)-(Number(a.lastActivity)||0));
            for(const session of sessions){const option=document.createElement('option');option.value=session.id;option.textContent=(session.shortCode||session.id)+' · '+(session.remark||'');select.append(option);}
            const desired=new URLSearchParams(location.search).get('session');if(desired)input.value=desired;
            await loadTunnel(desired||select.value,Boolean(desired));
        }catch(error){status.textContent=t('权限读取失败')+' ['+error.message+']';}
    }
    document.addEventListener('DOMContentLoaded',init);
})(window);
