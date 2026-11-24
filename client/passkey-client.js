(function(global){
    'use strict';
    const t=(value,...args)=>{let text=global.TunnelI18n?.t(value)||value;args.forEach((arg,index)=>{text=text.replaceAll('{'+index+'}',String(arg));});return text;};
    function available(){
        if(!global.isSecureContext)throw Error(t('Passkey 需要 HTTPS 安全连接'));
        if(!global.PublicKeyCredential||!navigator.credentials||!global.SimpleWebAuthnBrowser)throw Error(t('当前浏览器不支持 Passkey，请使用支持通行密钥的浏览器'));
    }
    async function request(path,body,context={}){
        if(global.DiskClient)return global.DiskClient.raw('/passkeys'+path,{...context,diskSpace:'',...(body?global.DiskClient.json('POST',body):{})});
        const response=await fetch('/api/telegram/drive/passkeys'+path,{credentials:'same-origin',cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
        const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'PASSKEY_FAILED'),data);return data;
    }
    function panel(title){
        const dialog=document.createElement('dialog');dialog.className='passkey-choice';
        const heading=document.createElement('h2'),status=document.createElement('p'),actions=document.createElement('div');
        heading.textContent=t(title);status.setAttribute('role','status');dialog.append(heading,status,actions);document.body.append(dialog);dialog.showModal();
        return {dialog,status,actions};
    }
    function button(container,label,run){const element=document.createElement('button');element.type='button';element.textContent=label;element.onclick=run;container.append(element);return element;}
    async function direct(username,rpID,context,addAccount){
        const flow=await request('/login/options',{username,rpID,addAccount},context);
        const response=await global.SimpleWebAuthnBrowser.startAuthentication({optionsJSON:flow.options});
        return request('/verify',{flow_id:flow.flow_id,response,addAccount},context);
    }
    async function handoff(username,rpID,context,signal){
        // Open synchronously from the explicit user action; never put a long
        // lived login cookie or user-supplied identity into a redirect URL.
        const popup=global.open('about:blank','_blank','popup,width=600,height=720');
        if(!popup)throw Error(t('请允许弹出认证窗口后重试'));
        let flow;
        try{flow=await request('/handoff/start',{username,rpID,returnPath:location.pathname+location.search+location.hash},context);}catch(error){popup.close();throw error;}
        if(signal.aborted){popup.close();await request('/handoff/cancel',{flow:flow.flow_id},context).catch(()=>{});throw Error(t('认证已取消或过期，请重试'));}
        return new Promise((resolve,reject)=>{
            let settled=false;
            const finish=(error,result)=>{if(settled)return;settled=true;clearInterval(timer);signal.removeEventListener('abort',cancel);global.removeEventListener('message',receive);try{popup.close();}catch(_){}if(error)request('/handoff/cancel',{flow:flow.flow_id},context).catch(()=>{});error?reject(error):resolve(result);};
            const cancel=()=>finish(Error(t('认证已取消或过期，请重试')));
            const receive=async event=>{
                if(settled||event.origin!==location.origin||event.source!==popup||event.data?.type!=='disk-passkey-complete'||event.data.flow!==flow.flow_id)return;
                try{const data=await global.DiskClient.raw('/me',{accountId:'',diskSpace:''});
                    if(data.identity?.id!==event.data.accountId)throw Error('PASSKEY_FLOW_INVALID');
                    finish(null,{identity:data.identity,authenticatedRpID:rpID});
                }catch(error){finish(error);}
            };
            global.addEventListener('message',receive);
            signal.addEventListener('abort',cancel,{once:true});
            const expires=Date.now()+300000;
            const timer=setInterval(()=>{if(popup.closed||Date.now()>=expires)finish(Error(t('认证已取消或过期，请重试')));},500);
            popup.location=flow.url;
        });
    }
    async function login({username,context={},addAccount=true}){
        available();
        const choices=await request('/choices',{username},context),rpIDs=choices.rpIDs||[];
        if(!rpIDs.length)throw Error(t('没有可用的认证域名，请联系管理员或使用已关联的登录方式'));
        const first=rpIDs[0];let initialError;
        try{
            const capabilities=await global.PublicKeyCredential.getClientCapabilities?.();
            if(first!==location.hostname&&capabilities?.relatedOrigins===false)throw Error('ROR_UNAVAILABLE');
            return await direct(username,first,context,addAccount);
        }catch(error){initialError=error;}
        return new Promise((resolve,reject)=>{
            const {dialog,status,actions}=panel('选择 Passkey 验证方式');
            const controller=new AbortController();
            status.textContent=t('直接验证未完成，可重试或前往原域名验证')+' ['+(initialError.name||initialError.message)+']';
            let done=false;
            const finish=result=>{done=true;dialog.close();resolve(result);};
            const run=fn=>async()=>{const buttons=[...actions.querySelectorAll('button')];buttons.forEach(node=>node.disabled=true);try{finish(await fn());}catch(error){status.textContent=t('操作失败')+' ['+error.message+']';}finally{buttons.forEach(node=>node.disabled=false);}};
            for(const rpID of rpIDs){
                button(actions,t('使用 {0} 验证',rpID),run(()=>direct(username,rpID,context,addAccount)));
                if(rpID!==location.hostname)button(actions,t('前往 {0} 验证',rpID),run(()=>handoff(username,rpID,context,controller.signal)));
            }
            button(actions,t('取消'),()=>dialog.close());
            dialog.onclose=()=>{dialog.remove();if(!done){controller.abort();reject(Error(t('认证已取消或过期，请重试')));}};
        });
    }
    async function register({username,context={},addAccount=false}){
        available();
        const flow=await request('/register/options',{username,addAccount},context);
        if(flow.loginRequired){const result=await login({username,context,addAccount:true});return {...result,offerPasskey:true};}
        const response=await global.SimpleWebAuthnBrowser.startRegistration({optionsJSON:flow.options});
        return request('/verify',{flow_id:flow.flow_id,response,addAccount},context);
    }
    async function offer(result){
        if(!result.offerPasskey&&result.authenticatedRpID===location.hostname)return;
        const user=result.identity;if(!user)return;
        const {dialog,status,actions}=panel('为当前域名创建 Passkey');
        status.textContent=t('已验证原账号 {0}。可为该账号再创建另一把属于当前域名（{1}）的 Passkey；原有凭据保持有效，也可以暂不创建。',user.username,location.hostname);
        button(actions,t('为当前域名创建 Passkey'),async()=>{
            actions.querySelectorAll('button').forEach(node=>node.disabled=true);
            try{await register({username:user.username,context:{accountId:user.id},addAccount:false});dialog.close();}
            catch(error){status.textContent=t('操作失败')+' ['+error.message+']';actions.querySelectorAll('button').forEach(node=>node.disabled=false);}
        });
        button(actions,t('暂不创建'),()=>dialog.close());dialog.onclose=()=>dialog.remove();
    }
    global.PasskeyClient={login,register,offer,request,t};
})(window);
