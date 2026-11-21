'use strict';
(() => {
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
                    const holder=cell(row,'');const label=document.createElement('label'),check=document.createElement('input');
                    check.type='checkbox';check.checked=user.permissions?.[key]===true;check.setAttribute('aria-label',`${user.name||user.id}: ${key}`);
                    label.append(check,document.createTextNode(check.checked?'已开启':'关闭'));
                    check.addEventListener('change',()=>{label.lastChild.textContent=check.checked?'已开启':'关闭';});holder.append(label);return check;
                });
                const action=cell(row,'');action.className='actions';const save=document.createElement('button');save.type='button';save.textContent='保存权限';action.append(save);
                save.onclick=async()=>{
                    const permissions=Object.fromEntries(keys.map((key,i)=>[key,inputs[i].checked]));
                    if(!confirm(`确定更新「${user.name||user.id}」的三个权限？`))return;
                    row.setAttribute('aria-busy','true');save.disabled=true;
                    try{await json(`/api/telegram/disk-admin/users/${encodeURIComponent(user.id)}/permissions`,{
                        method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({permissions})});
                        notice.textContent=`已保存 ${user.name||user.id} 的权限；现有连接的后续操作立即按新权限检查。`;
                    }catch(error){notice.textContent=`保存失败：${error.message}`;}
                    finally{save.disabled=false;row.removeAttribute('aria-busy');}
                };
                table.append(row);
            }
            if(!users.length)notice.textContent='暂无网盘账号';else notice.textContent=`共 ${users.length} 个账号。`;
        }catch(error){notice.textContent=`加载失败：${error.message}`;}
    }
    document.getElementById('reload').onclick=load;load();
})();
