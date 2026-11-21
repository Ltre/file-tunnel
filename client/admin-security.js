'use strict';
const tbody=document.getElementById('sessions'),status=document.getElementById('state');
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
        cell(session.os||'未知');cell(session.browser||'未知');cell(date(session.lastActivityAt));cell(date(session.expiresAt));
        const bound=cell(session.dbscBound?'已绑定':'未绑定');bound.className=session.dbscBound?'tag':'error';
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
