'use strict';
(() => {
    const t=value=>window.TunnelI18n?.t(value)||value;
    const keys = ['disk.s3.manage','disk.riskyUpload','webZip.publishEdit'];
    const table = document.getElementById('users'), notice = document.getElementById('notice');
    async function json(url, options) {
        const response = await fetch(url,{cache:'no-store',credentials:'same-origin',...options});
        const data=await response.json().catch(()=>({}));
        if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);
        return data;
    }
    const cell = (row,text,tag='td') => {const element=document.createElement(tag);element.textContent=text;row.append(element);return element;};
    async function load() {
        notice.textContent='正在读取用户列表…';table.replaceChildren();
        try {
            const {users=[]}=await json('/api/telegram/disk-admin/users');
            for (const user of users) {
                const row=document.createElement('tr');
                const who=cell(row,user.name||user.username||'网盘用户');
                const id=document.createElement('small');id.textContent=`${user.provider||''} · ${user.id}`;who.append(id);
                const inputs=keys.map(key=>{
                    const holder=cell(row,''),label=document.createElement('span'),check=document.createElement('button'),state=document.createElement('span');
                    label.className='permission-switch';check.type='button';check.checked=user.permissions?.[key]===true;check.setAttribute('role','switch');check.setAttribute('aria-label',`${user.name||user.id}: ${key}`);
                    const update=()=>{check.setAttribute('aria-checked',String(check.checked));state.textContent=t(check.checked?'已启用':'已禁用');};
                    check.onclick=()=>{check.checked=!check.checked;update();};update();label.append(check,state);holder.append(label);return check;
                });
                const action=cell(row,'');action.className='actions';const save=document.createElement('button');save.type='button';save.className='save-permissions';save.textContent=t('保存权限');action.append(save);
                const manage=document.createElement('button');manage.type='button';manage.textContent=t('Passkey 管理');manage.onclick=()=>showPasskeys(user);action.append(manage);
                save.onclick=async()=>{
                    const permissions=Object.fromEntries(keys.map((key,i)=>[key,inputs[i].checked]));
                    if(!confirm(`确定更新「${user.name||user.id}」的三个权限？`))return;
                    row.setAttribute('aria-busy','true');save.disabled=true;inputs.forEach(input=>input.disabled=true);
                    try{await json(`/api/telegram/disk-admin/users/${encodeURIComponent(user.id)}/permissions`,{
                        method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({permissions})});
                        notice.textContent=`已保存 ${user.name||user.id} 的权限；现有连接的后续操作立即按新权限检查。`;
                    }catch(error){notice.textContent=`保存失败：${error.message}`;}
                    finally{save.disabled=false;inputs.forEach(input=>input.disabled=false);row.removeAttribute('aria-busy');}
                };
                table.append(row);
            }
            if(!users.length)notice.textContent='暂无网盘账号';else notice.textContent=`共 ${users.length} 个账号。`;
        }catch(error){notice.textContent=`加载失败：${error.message}`;}
    }
    async function showPasskeys(user){
        const dialog=document.createElement('dialog');dialog.className='passkey-dialog';
        const header=document.createElement('header'),title=document.createElement('h2'),close=document.createElement('button'),status=document.createElement('p'),list=document.createElement('div');
        title.textContent=t('Passkey 管理')+' · '+(user.name||user.id);close.textContent=t('关闭');close.type='button';list.className='passkey-list';
        header.append(title,close);dialog.append(header,status,list);document.body.append(dialog);dialog.showModal();close.onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();dialog.onclick=event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}};
        const reload=async()=>{try{const data=await json(`/api/telegram/disk-admin/users/${encodeURIComponent(user.id)}/passkeys`);if(!dialog.isConnected)return;
            const domains=[...new Set(data.passkeys.map(key=>key.rpID))];
            status.textContent=domains.length===1?(t('仅依赖域名 {0}，停用前请为该账号添加其他可用域名的独立 Passkey。').replace('{0}',domains[0])):'';
            window.PasskeyView.render(list,data.passkeys,{remove:async key=>{if(!confirm(t('确定移除此 Passkey？')))return;try{await json(`/api/telegram/disk-admin/users/${encodeURIComponent(user.id)}/passkeys/${encodeURIComponent(key.id)}`,{method:'DELETE'});await reload();}catch(error){status.textContent=error.message==='PASSKEY_LAST_CREDENTIAL'?t('不能移除最后一个登录凭据'):t('操作失败')+' ['+error.message+']';}}});
        }catch(error){status.textContent=t('加载失败')+' ['+error.message+']';}};await reload();
    }
    json('/api/telegram/disk-admin/risk-file-types').then(data=>{const tip=document.getElementById('riskTooltip');
        const explanation=document.createElement('p');explanation.textContent=t('文件名、扩展名或 MIME 命中任一规则时，按风险文件处理。');tip.append(explanation);
        for(const [label,values] of [['扩展名',data.extensions?.map(value=>'.'+value)],['文件名',data.names],['MIME',data.mimes]]){const p=document.createElement('p');p.textContent=t(label)+': '+(values||[]).join(', ');tip.append(p);}
    }).catch(()=>{document.getElementById('riskTooltip').textContent=t('加载失败');});
    async function configureOrigins(){
        const dialog=document.createElement('dialog');dialog.className='passkey-dialog';
        const title=document.createElement('h2'),help=document.createElement('p'),input=document.createElement('textarea'),label=document.createElement('label'),status=document.createElement('p'),dependencies=document.createElement('div'),save=document.createElement('button'),close=document.createElement('button');
        title.textContent=t('ROR 域名配置');help.textContent=t('仅填写本系统受控的可信入口。每行一个域名或完整 HTTPS Origin，不填写路径；保存后立即生效，不改变已有 Passkey 的 RP ID。');
        label.textContent=t('可信域名列表');input.className='origin-editor';input.setAttribute('aria-label',label.textContent);input.spellcheck=false;label.append(input);dependencies.className='origin-dependencies';status.setAttribute('role','status');
        save.type=close.type='button';save.textContent=t('保存');save.disabled=true;close.textContent=t('关闭');dialog.append(title,help,label,dependencies,status,save,close);document.body.append(dialog);dialog.showModal();close.onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();
        let config;
        const showDependencies=()=>{dependencies.textContent=t('仅依赖单一域名的账号')+'\n'+(config.dependencies||[]).filter(user=>user.rpIDs.length===1).map(user=>user.username+' · '+user.rpIDs[0]).join('\n');};
        try{config=await json('/api/telegram/disk-admin/passkey-origins');if(!dialog.isConnected)return;input.value=config.origins.join('\n');showDependencies();save.disabled=false;}
        catch(error){status.textContent=t('加载失败')+' ['+error.message+']';}
        save.onclick=async()=>{
            const origins=[...new Set(input.value.split(/[\s,]+/).filter(Boolean).map(value=>{
                const origin=value.includes('://')?value:'https://'+value;
                try{const url=new URL(origin);return url.protocol==='https:'&&url.pathname==='/'&&!url.search&&!url.hash&&!url.username&&!url.password?url.origin:origin;}catch(_){return origin;}
            }))];
            const nextHosts=new Set(origins.map(value=>{try{return new URL(value).hostname;}catch(_){return '';}}));
            const removedHosts=new Set(config.origins.map(value=>new URL(value).hostname).filter(host=>!nextHosts.has(host)));
            const affected=(config.dependencies||[]).filter(user=>user.rpIDs.every(host=>removedHosts.has(host)));
            if(affected.length&&!confirm(t('以下账号仅依赖将移除的域名，请先确认独立凭据或其他登录方式：')+'\n'+affected.map(user=>user.username).join('\n')))return;
            save.disabled=true;input.disabled=true;
            try{config=await json('/api/telegram/disk-admin/passkey-origins',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({origins,revision:config.revision})});input.value=config.origins.join('\n');showDependencies();status.textContent=t('ROR 域名配置已保存并生效');}
            catch(error){status.textContent=error.message==='PASSKEY_ORIGIN_SETTINGS_CONFLICT'?t('配置已被其他操作更新，请关闭后重新读取'):t('保存失败，请检查域名格式后重试')+' ['+error.message+']';}
            finally{save.disabled=false;input.disabled=false;}
        };
    }
    document.getElementById('configureOrigins').onclick=configureOrigins;
    document.getElementById('reload').onclick=load;load();
})();
