'use strict';
const tbody=document.getElementById('sessions'),status=document.getElementById('state');
const translate=value=>window.TunnelI18n?.t(value)||value;
const date=value=>value?new Date(value).toLocaleString():'—';
async function update(){
    const response=await fetch('/api/admin/security/sessions',{cache:'no-store'});
    if(response.status===401){top.location.href='/admin-auth?next=/admin/security';return;}
    if(!response.ok)throw Error('无法获取管理员会话');
    const data=await response.json();
    tbody.replaceChildren();
    status.textContent=`会话 ${data.sessions.length} 条（撤销后立即失效）`;
    for(const session of data.sessions){
        const tr=document.createElement('tr');
        const cell=value=>{const td=document.createElement('td');td.textContent=String(value);tr.append(td);return td;};
        cell(`${session.model||'未知'}${session.id===data.currentSessionId?'（当前设备）':''}`);
        cell(session.os||'未知');cell(session.browser||'未知');
        const activity=cell('');
        for(const entry of session.ipActivity||[]){
            const line=document.createElement('div');
            const at=new Date(entry.lastActivityAt),pad=value=>String(value).padStart(2,'0');
            line.textContent=entry.address+', '+(entry.lastActivityAt?`${at.getFullYear()}-${pad(at.getMonth()+1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`:'—');
            if(entry.legacy)line.textContent+=' ('+(window.TunnelI18n?.t('仅记录会话建立时间')||'仅记录会话建立时间')+')';
            activity.append(line);
        }
        if(!activity.childNodes.length)activity.textContent=date(session.lastActivityAt);
        const expiry=cell('');
        if(session.independentAuth){for(const [label,at]of [['TOTP',session.totpExpiresAt],['Passkey',session.passkeyExpiresAt]]){const line=document.createElement('div');line.textContent=label+': '+date(at);if(at<=Date.now())line.className='error';expiry.append(line);}}
        else expiry.textContent=date(session.expiresAt);
        const localLabel='本机 HTTP 测试会话（未绑定 DBSC）';
        const independent=session.independentAuth===true||session.authMethod==='totp-passkey';
        const bound=cell(session.localTest?translate(session.localNetworkTest?'局域网直连测试会话（仅 TOTP）':localLabel):session.dbscBound?'DBSC · '+translate('已绑定'):independent?translate('TOTP + 管理员 Passkey'):translate('未绑定'));bound.className=session.dbscBound||independent?'tag':'error';
        const td=document.createElement('td'),button=document.createElement('button');
        button.textContent=session.revokedAt?'已撤销':'踢除此会话';button.disabled=Boolean(session.revokedAt);
        button.addEventListener('click',async()=>{
            if(!confirm('确定撤销此管理员会话吗？'))return;
            button.disabled=true;
            const result=await fetch('/api/admin/security/sessions/'+encodeURIComponent(session.id),{method:'DELETE'});
            if(!result.ok){button.disabled=false;alert('撤销失败');return;}
            update().catch(error=>{status.textContent=error.message;});
        });
        td.append(button);tr.append(td);tbody.append(tr);
    }
}
update().catch(error=>{status.textContent=error.message;});

// These routes and credentials belong to the administrator security domain.
// Do not use the front-end account selector, DiskClient or PasskeyClient here.
(()=>{
    const form=document.getElementById('adminPasskeyForm'),remark=document.getElementById('adminPasskeyRemark'),bind=document.getElementById('bindAdminPasskey'),notice=document.getElementById('adminPasskeyStatus'),list=document.getElementById('adminPasskeys');
    if(!form||!remark||!bind||!notice||!list)return;
    let binding=false;
    const available=()=>window.isSecureContext&&window.PublicKeyCredential&&window.SimpleWebAuthnBrowser&&navigator.credentials;
    async function request(path,body){
        const response=await fetch('/api/admin/security/passkeys'+path,{credentials:'same-origin',cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
        if(response.status===401){top.location.href='/admin-auth?next=/admin/security';throw Error('ADMIN_AUTH_REQUIRED');}
        const data=await response.json().catch(()=>({}));if(!response.ok)throw Error(data.error||'HTTP '+response.status);return data;
    }
    async function load(){
        const data=await request('');list.replaceChildren();
        for(const key of data.passkeys||[]){
            const tr=document.createElement('tr');
            for(const [index,value]of [key.remark||translate('未设置备注'),key.rpID,date(key.createdAt),key.lastUsedAt?date(key.lastUsedAt):translate('尚未使用')].entries()){
                const td=document.createElement('td');td.textContent=value;if(index<2)td.className='message-content';tr.append(td);
            }
            list.append(tr);
        }
        notice.textContent=(data.passkeys||[]).length?'':translate('尚未绑定管理员 Passkey');
        bind.disabled=binding||!available();
        if(!available())notice.textContent=translate('当前环境无法绑定管理员 Passkey，请使用支持 Passkey 的安全连接浏览器。');
    }
    form.addEventListener('submit',async event=>{
        event.preventDefault();if(binding||bind.disabled)return;binding=true;bind.disabled=true;remark.disabled=true;
        notice.textContent=translate('请在浏览器中确认绑定管理员 Passkey…');
        let verified=false;
        try{
            const flow=await request('/register/options',{remark:remark.value.trim()});
            const response=await window.SimpleWebAuthnBrowser.startRegistration({optionsJSON:flow.options});
            await request('/register/verify',{flow_id:flow.flow_id,response});
            verified=true;remark.value='';await load();notice.textContent=translate('管理员 Passkey 已绑定');
        }catch(error){notice.textContent=translate(verified?'管理员 Passkey 已绑定，但列表刷新失败，请刷新页面':'管理员 Passkey 绑定未完成，请重试')+' ['+error.message+']';}
        finally{binding=false;bind.disabled=!available();remark.disabled=false;}
    });
    load().catch(error=>{notice.textContent=translate('无法读取管理员 Passkey，请刷新后重试')+' ['+error.message+']';});
})();

(()=>{
    const form=document.getElementById('adminPolicyForm');if(!form)return;
    const totp=document.getElementById('totpMonths'),passkey=document.getElementById('passkeyDays'),button=document.getElementById('saveAdminPolicy'),notice=document.getElementById('adminPolicyStatus');let revision;
    async function load(){const response=await fetch('/api/admin/security/auth-policy',{cache:'no-store'});if(!response.ok)throw Error('HTTP '+response.status);const value=await response.json();totp.value=value.totpMonths;passkey.value=value.passkeyDays;revision=value.revision;button.disabled=false;}
    form.onsubmit=async event=>{event.preventDefault();button.disabled=true;
        try{const response=await fetch('/api/admin/security/auth-policy',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({totpMonths:Number(totp.value),passkeyDays:Number(passkey.value),revision})});const value=await response.json();if(!response.ok)throw Error(value.error||'HTTP '+response.status);revision=value.revision;notice.textContent=translate('管理员验证有效期已保存');await update();}
        catch(error){notice.textContent=translate('保存失败，请确认 TOTP 有效期大于 Passkey 有效期，并刷新后重试')+' ['+error.message+']';}
        finally{button.disabled=false;}
    };
    load().catch(error=>{notice.textContent=translate('无法读取管理员验证有效期，请刷新后重试')+' ['+error.message+']';});
})();
