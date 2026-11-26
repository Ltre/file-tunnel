'use strict';
(()=>{
    let accountId=new URLSearchParams(location.search).get('disk_account')||'';
    window.DiskClient.setAccount(accountId);
    const status=document.getElementById('status'),add=document.getElementById('add'),context={accountId,diskSpace:''};
    const t=window.PasskeyClient.t;let identity;
    if(window.parent!==window&&new URLSearchParams(location.search).get('embedded')==='1'){
        document.documentElement.classList.add('account-center-embedded');
        const close=()=>window.parent.postMessage({type:'account-center-close'},location.origin);
        const home=document.querySelector('a[href="/"]');
        if(home){home.textContent=t('关闭');home.onclick=event=>{event.preventDefault();close();};}
        window.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]')){event.preventDefault();close();}});
    }
    const current=()=>window.DiskClient.getAccount()===accountId;
    async function authenticated(run){
        try{return await run();}catch(error){
            if(error.message!=='PASSKEY_REAUTH_REQUIRED')throw error;
            if(!identity.username)throw Error(t('请先通过原登录方式重新验证，再打开账号中心'));
            const result=await window.PasskeyClient.login({username:identity.username,context,addAccount:true});
            if(!current()||result.identity?.id!==identity.id)throw Error('PASSKEY_FLOW_INVALID');
            return run();
        }
    }
    async function load(){
        const data=await window.DiskClient.raw('/passkeys',context);if(!current())return;
        identity=data.identity;
        if(!accountId){accountId=identity.id;context.accountId=accountId;window.DiskClient.setAccount(accountId);const url=new URL(location.href);url.searchParams.set('disk_account',accountId);history.replaceState(history.state,'',url);}
        document.getElementById('identity').textContent=`${identity.username||identity.name} · ${identity.id} · ${data.passkeys.length} Passkey`;
        const username=document.getElementById('username');
        document.getElementById('usernameField').hidden=false;
        username.readOnly=Boolean(identity.username);
        if(identity.username)username.value=identity.username;
        else if(!username.value)username.value=identity.telegramId||'';
        add.disabled=false;
        const enabled=new Set((data.origins||[]).map(value=>new URL(value).hostname));
        const atRisk=enabled.size&&data.passkeys.length&&data.passkeys.every(key=>!enabled.has(key.rpID));
        const domains=[...new Set(data.passkeys.map(key=>key.rpID))];
        document.getElementById('domainWarning').textContent=atRisk?t('现有 Passkey 依赖未启用的域名，请在可用域名添加独立凭据；无法验证时请使用已关联的登录方式或联系管理员'):domains.length===1?t('仅依赖域名 {0}，停用前请为该账号添加其他可用域名的独立 Passkey。',domains[0]):'';
        window.PasskeyView.render(document.getElementById('keys'),data.passkeys,{rename:async key=>{
            const dialog=document.createElement('dialog');dialog.className='passkey-choice';
            const title=document.createElement('h2'),input=document.createElement('input'),save=document.createElement('button'),cancel=document.createElement('button'),notice=document.createElement('p');
            title.textContent=t('修改备注');input.value=key.remark;input.maxLength=100;input.setAttribute('aria-label',t('备注名'));save.textContent=t('保存');cancel.textContent=t('取消');
            dialog.append(title,input,save,cancel,notice);document.body.append(dialog);dialog.showModal();cancel.onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();
            save.onclick=async()=>{save.disabled=true;try{await authenticated(()=>window.DiskClient.raw('/passkeys/'+encodeURIComponent(key.id),{...context,...window.DiskClient.json('PATCH',{remark:input.value})}));dialog.close();await load();}catch(error){notice.textContent=t('操作失败')+' ['+error.message+']';}finally{save.disabled=false;}};
        }});
    }
    add.onclick=async()=>{add.disabled=true;try{const username=identity.username||document.getElementById('username').value;await authenticated(()=>window.PasskeyClient.register({username,context,addAccount:false}));await load();status.textContent=t('Passkey 已添加，原有凭据保持有效');}catch(error){status.textContent=error.message==='USERNAME_EXISTS'?t('用户名已被使用，请填写其他用户名'):t('操作失败')+' ['+error.message+']';}finally{add.disabled=false;}};
    load().catch(error=>{status.textContent=t('账号操作未完成，请重试')+' ['+error.message+']';});
})();
