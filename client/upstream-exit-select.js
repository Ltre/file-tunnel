(function (global) {
    'use strict';
    let configuration;
    const config=()=>configuration ||= fetch('/api/upstream-exits',{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('无法读取网络出口设置');return r.json();}).catch(error=>{configuration=null;throw error;});
    global.UpstreamExitUI={
        createSelect(after){
            const row=document.createElement('label');row.className='network-exit-field';const text=document.createElement('span');text.textContent='网络出口';
            const input=document.createElement('input');input.type='hidden';input.value='';const select=document.createElement('select');select.setAttribute('aria-label','网络出口');
            const initial=document.createElement('option');initial.value='';initial.textContent='使用服务默认出口';select.append(initial);
            row.append(text,select,input);(after.closest('.url-row,.form-grid') || after).insertAdjacentElement('afterend',row);
            input.refreshDisplay=()=>{let value=input.value;if(value && ![...select.options].some(o=>o.value===value)){const unknown=document.createElement('option');unknown.value=value;unknown.textContent='此前选择的节点（正在读取设置）';unknown.dataset.pending='true';select.append(unknown);}select.value=value;};
            select.onchange=()=>{input.value=select.value;input.dispatchEvent(new Event('input',{bubbles:true}));};
            config().then(data=>{select.querySelectorAll('[data-pending]').forEach(o=>o.remove());for(const node of [{id:'direct',name:'本机直连'},...data.nodes]){const option=document.createElement('option');option.value=node.id;option.textContent=node.name;select.append(option);}input.refreshDisplay();if(select.selectedOptions[0]?.dataset.pending)select.selectedOptions[0].textContent='此前选择的节点已不存在，请重新选择';}).catch(error=>{row.title=error.message;});
            return input;
        },
        route(value){const box=document.createElement('div');box.className='network-exit-route';if(!value)return box;const title=document.createElement('strong');title.textContent='网络出口：'+(value.selected?.name||'等待选择');box.append(title);
            if(value.attempts?.length){const ol=document.createElement('ol');for(const attempt of value.attempts){const li=document.createElement('li');li.textContent=attempt.name+' · '+({trying:'尝试中',success:'已采用',cached:'已读取缓存，出口尚未验证',failed:'未取得所需内容'}[attempt.status]||attempt.status);ol.append(li);}box.append(ol);}return box;}
    };
})(window);
