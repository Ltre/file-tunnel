'use strict';
(async()=>{
    const status=document.getElementById('status'),verify=document.getElementById('verify'),back=document.getElementById('return');
    const t=(value,...args)=>{let text=window.TunnelI18n?.t(value)||value;args.forEach((arg,index)=>text=text.replaceAll('{'+index+'}',arg));return text;};
    async function request(path,body){const response=await fetch('/api/telegram/drive/passkeys/handoff/'+path,{credentials:'same-origin',cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(data.error||'PASSKEY_FLOW_INVALID');return data;}
    try{
        const params=new URLSearchParams(location.hash.slice(1));
        if(params.has('complete')){
            const flow=params.get('complete'),code=params.get('code');history.replaceState(null,'',location.pathname);
            const result=await request('complete',{flow,code});
            status.textContent=t('认证成功，请返回原页面');
            if(window.opener&&!window.opener.closed){window.opener.postMessage({type:'disk-passkey-complete',flow,accountId:result.identity.id},location.origin);}
            back.hidden=false;back.href=result.returnPath;back.textContent=t('返回原页面');return;
        }
        const flow=new URLSearchParams(location.search).get('flow');
        const info=await request('info?flow='+encodeURIComponent(flow));
        status.textContent=t('验证账号 {0} 后返回 {1}',info.username,info.targetOrigin);verify.hidden=false;
        verify.onclick=async()=>{
            verify.disabled=true;
            try{const attempt=await request('options',{flow}),response=await window.SimpleWebAuthnBrowser.startAuthentication({optionsJSON:attempt.options});const result=await request('verify',{flow_id:attempt.flow_id,response});location.replace(result.url);}
            catch(error){status.textContent=t('操作失败')+' ['+error.message+']';verify.disabled=false;}
        };
    }catch(error){status.textContent=t('认证已取消或过期，请重试')+' ['+error.message+']';}
})();
