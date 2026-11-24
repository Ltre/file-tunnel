(function(global){
    'use strict';
    const t=value=>global.TunnelI18n?.t(value)||value;
    function date(value){
        if(value===null||value===undefined)return t('暂无使用记录');
        if(!value)return t('尚未使用');
        const d=new Date(value),pad=n=>String(n).padStart(2,'0');
        return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }
    function render(target,keys,{rename,remove}={}){
        target.replaceChildren();
        if(!keys.length){target.textContent=t('暂无 Passkey');return;}
        const table=document.createElement('table'),head=document.createElement('thead'),row=document.createElement('tr');
        for(const text of ['备注名','RP ID','创建时间','最近使用',...(rename||remove?['操作']:[])]){const th=document.createElement('th');th.textContent=t(text);row.append(th);}
        head.append(row);table.append(head);const body=document.createElement('tbody');table.append(body);
        for(const key of keys){
            const tr=document.createElement('tr');tr.dataset.credentialId=key.id;
            const cell=text=>{const td=document.createElement('td');td.textContent=text;tr.append(td);return td;};
            const note=cell(key.remark||t('未设置备注'));note.className='message-content';
            cell(key.rpID).className='message-content';cell(key.createdAt?date(key.createdAt):'—');cell(date(key.lastUsedAt));
            if(rename||remove){const actions=cell('');
                for(const [label,run] of [['修改备注',rename],['移除',remove]])if(run){
                    const button=document.createElement('button');button.type='button';button.textContent=t(label);
                    button.onclick=async()=>{button.disabled=true;try{await run(key);}finally{button.disabled=false;}};actions.append(button);
                }
            }
            body.append(tr);
        }
        target.append(table);
    }
    global.PasskeyView={render,date};
})(window);
