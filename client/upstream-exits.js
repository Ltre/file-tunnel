(function () {
    'use strict';
    const names={telegram:'Telegram',youtube:'YT（YouTube / YouTube Music）',twitter:'X / Twitter',facebook:'Facebook',line:'LINE',instagram:'Instagram',tiktok:'TikTok',bilibili:'B站',netease:'网易云音乐',other:'其它服务'};
    const status=document.getElementById('upstreamStatus'),list=document.getElementById('nodeList'),editor=document.getElementById('nodeEditor');
    let data,selected='new',selectedService='telegram';const drafts=new Map(),serviceDrafts=new Map(),savingServices=new Set();
    async function api(url,method='GET',body){const r=await fetch('/api/upstream-exits'+url,{method,cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const value=await r.json();if(!r.ok)throw Error(value.error||'操作失败');return value;}
    const el=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e;};
    function showTestExits(){const select=document.getElementById('testExit'),selected=select.value;select.replaceChildren();for(const node of [{id:'direct',name:'本机直连'},...data.nodes]){const option=el('option',node.name);option.value=node.id;select.append(option);}select.value=[...select.options].some(option=>option.value===selected)?selected:'direct';}
    function feedback(error){status.textContent=error.message||String(error);status.style.color='#b72c40';}
    function success(message){status.textContent=message;status.style.color='#23764c';}
    function field(form,name,label,value,type='text'){const row=el('label'),input=el('input');input.type=type;input.name=name;input.value=value||'';row.append(el('span',label),input);form.append(row);return input;}
    function checkbox(form,label,value){const row=el('label'),input=el('input');row.className='check';input.type='checkbox';input.checked=value;row.append(input,el('span',label));form.append(row);return input;}
    function remember(){const form=editor.querySelector('form');if(form)drafts.set(selected,{...data.nodes.find(node=>node.id===selected),...drafts.get(selected),...Object.fromEntries(new FormData(form)),verifyTls:form.elements.verifyTls.checked});}
    function showNodes(){showTestExits();list.replaceChildren();const add=el('button','＋ 新增节点');add.className='add-node';add.type='button';add.onclick=()=>{remember();selected='new';showNodes();showEditor();};list.append(add);
        for(const node of data.nodes){const b=el('button',node.name);b.type='button';b.setAttribute('aria-current',String(node.id===selected));b.onclick=()=>{remember();selected=node.id;showNodes();showEditor();};list.append(b);}
        add.setAttribute('aria-current',String(selected==='new'));
    }
    function showEditor(){editor.replaceChildren();const original=data.nodes.find(n=>n.id===selected)||{verifyTls:true,port:443},node=drafts.get(selected)||original;
        const form=el('form');form.append(el('h2',selected==='new'?'新增 Trojan 节点':original.name));
        field(form,'name','节点名称',node.name).required=true;field(form,'server','服务器 IP / 域名',node.server).required=true;
        const port=field(form,'port','端口',node.port,'number');port.min=1;port.max=65535;port.required=true;
        const password=field(form,'password','Trojan 密码',node.password,'password');password.autocomplete='new-password';password.placeholder=original.hasPassword?'已保存，留空保持不变':'';password.required=!original.hasPassword;
        field(form,'serverName','TLS SNI / Server Name',node.serverName);const verify=checkbox(form,'验证 TLS 证书',node.verifyTls!==false);verify.name='verifyTls';
        field(form,'remark','备注',node.remark);const actions=el('div');actions.className='actions';const save=el('button','保存');save.type='submit';save.className='primary';actions.append(save);const destructive=el('div');destructive.className='actions node-danger-actions';
        if(selected!=='new'){const remove=el('button','删除节点');remove.type='button';remove.className='danger';remove.onclick=async()=>{if(!confirm('删除这个节点？正在执行的任务继续使用发起时的配置；引用此节点的服务设置将移除该节点。'))return;const removingId=original.id;remove.disabled=true;try{await api('/nodes/'+encodeURIComponent(removingId),'DELETE');if(selected!==removingId)remember();drafts.delete(removingId);data=await api('');if(selected===removingId)selected='new';showNodes();showEditor();showServices();success('节点已删除');}catch(e){feedback(e);}finally{remove.disabled=false;}};destructive.append(remove);}
        const result=el('pre');result.className='exit-test-result';result.setAttribute('role','status');
        const confirmNode=el('button','出口IP测试'),pageTest=el('button','测试打开页面');confirmNode.type=pageTest.type='button';confirmNode.disabled=pageTest.disabled=selected==='new';
        confirmNode.title=pageTest.title='使用已保存的节点配置；修改后请先保存';
        confirmNode.onclick=async()=>{confirmNode.disabled=true;result.textContent='正在确认出口 IP…';try{const value=await api('/confirm','POST',{exit:original.id});result.textContent=value.exitName+'：'+value.ip+'\n耗时 '+value.durationMs+' ms';}catch(error){result.textContent=error.message;}finally{confirmNode.disabled=false;runtime();}};
        pageTest.onclick=()=>openPageTest(original.id);
        actions.append(confirmNode,pageTest);
        form.append(actions,result);if(destructive.childElementCount)form.append(destructive);
        form.onsubmit=async event=>{
            event.preventDefault();
            const savingId=selected,input={...Object.fromEntries(new FormData(form)),verifyTls:verify.checked,revision:node.revision};
            const controls=[...form.elements].map(control=>[control,control.disabled]);
            for(const [control]of controls)control.disabled=true;
            try{
                const savedNode=await api('/nodes'+(savingId==='new'?'':'/'+encodeURIComponent(savingId)),savingId==='new'?'POST':'PUT',input);
                if(selected!==savingId)remember();drafts.delete(savingId);
                data=await api('');if(selected===savingId)selected=savedNode.id;
                showNodes();showEditor();showServices();success('节点已保存');
            }catch(e){feedback(e);}finally{for(const [control,disabled]of controls)control.disabled=disabled;}
        };
        editor.append(form);
    }
    function exitOptions(select,value){for(const n of [{id:'direct',name:'本机直连'},...data.nodes]){const o=el('option',n.name);o.value=n.id;select.append(o);}select.value=value;}
    function showServices(){const host=document.getElementById('serviceSettings');for(const form of host.querySelectorAll('form'))serviceDrafts.set(form.dataset.serviceId,form.capture());host.replaceChildren();const tabs=document.getElementById('serviceTabs');tabs.replaceChildren();for(const service of data.services){const tab=el('button',service.id==='youtube'?'YT':names[service.id]);tab.type='button';tab.id='service-tab-'+service.id;tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(service.id===selectedService));tab.setAttribute('aria-controls','serviceSettings');tab.onclick=()=>{selectedService=service.id;showServices();};tab.onkeydown=event=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const index=data.services.findIndex(item=>item.id===service.id),next=event.key==='Home'?0:event.key==='End'?data.services.length-1:(index+(event.key==='ArrowDown'?1:-1)+data.services.length)%data.services.length;selectedService=data.services[next].id;showServices();document.getElementById('service-tab-'+selectedService).focus();};tab.tabIndex=service.id===selectedService?0:-1;tabs.append(tab);}host.setAttribute('aria-labelledby','service-tab-'+selectedService);for(const saved of data.services.filter(item=>item.id===selectedService)){const service={...saved,...serviceDrafts.get(saved.id)},form=el('form');form.dataset.serviceId=service.id;form.append(el('h2','访问'+names[service.id]+'的网络出口设置'));
        const defaultLabel=el('label','默认出口'),choice=el('select');exitOptions(choice,service.defaultExit);defaultLabel.append(choice);form.append(defaultLabel);
        const modeLabel=el('label','候选节点切换顺序'),mode=el('select');for(const [id,text]of [['ordered','指定顺序'],['random','随机顺序']]){const option=el('option',text);option.value=id;mode.append(option);}mode.value=service.mode;modeLabel.append(mode);form.append(modeLabel);
        const direct=checkbox(form,'本机直连参与节点轮询',service.includeDirect);const order=el('ol');order.className='exit-order';let ids=[...new Set([...service.order,...data.nodes.map(n=>n.id),'direct'])];
        function renderOrder(){order.replaceChildren();const visible=ids.filter(id=>id!=='direct'||direct.checked);for(const id of visible){const node=id==='direct'?{name:'本机直连'}:data.nodes.find(n=>n.id===id);if(!node)continue;const li=el('li');li.append(el('span',node.name));for(const [sign,delta]of [['↑',-1],['↓',1]]){const b=el('button',sign);b.type='button';b.disabled=mode.value==='random'||!visible[visible.indexOf(id)+delta];b.setAttribute('aria-label',node.name+(delta<0?'上移':'下移'));b.onclick=()=>{const at=ids.indexOf(id),next=ids.indexOf(visible[visible.indexOf(id)+delta]);if(next<0)return;[ids[at],ids[next]]=[ids[next],ids[at]];renderOrder();};li.append(b);}order.append(li);}}
        direct.onchange=mode.onchange=renderOrder;renderOrder();form.append(order);const save=el('button','保存此服务设置');save.className='primary';save.type='submit';form.append(save);
        form.capture=()=>({defaultExit:choice.value,mode:mode.value,includeDirect:direct.checked,order:ids.filter(id=>id!=='direct'||direct.checked),revision:service.revision});
        if(savingServices.has(service.id))for(const control of form.elements)control.disabled=true;
        form.onsubmit=async event=>{
            event.preventDefault();if(savingServices.has(service.id))return;
            const input=form.capture();savingServices.add(service.id);for(const control of form.elements)control.disabled=true;
            let saved=false;
            try{const value=await api('/services/'+service.id,'PUT',input);Object.assign(service,value);Object.assign(data.services.find(item=>item.id===service.id),value);serviceDrafts.delete(service.id);saved=true;success(names[service.id]+'出口设置已保存');}
            catch(e){feedback(e);}
            finally{savingServices.delete(service.id);const current=host.querySelector('form');if(current?.dataset.serviceId===service.id){if(!saved)serviceDrafts.set(service.id,current.capture());host.replaceChildren();showServices();}}
        };host.append(form);
    }}
    async function runtime(){try{const value=await api('');const box=document.getElementById('runtimeStatus');box.textContent=value.runtimes.length?value.runtimes.map(r=>r.name+'：'+(r.running?'运行中':r.starting?'启动中':'已停止')+' · '+r.activeTasks+' 个任务使用').join('；'):'未启动，实际任务使用 Trojan 节点时按需启动。';}catch(e){feedback(e);}}
    document.getElementById('refreshRuntime').onclick=runtime;
    let pageTestGeneration=0;
    function openPageTest(id){pageTestGeneration++;showTestExits();document.getElementById('testExit').value=id;document.getElementById('testExitButton').disabled=false;document.getElementById('testExitButton').textContent='开始测试';document.getElementById('exitTestResult').textContent='';document.getElementById('pageTestDialog').showModal();}
    document.getElementById('closePageTest').onclick=()=>document.getElementById('pageTestDialog').close();
    document.getElementById('pageTestDialog').addEventListener('close',()=>{pageTestGeneration++;});
    document.getElementById('exitTestForm').onsubmit=async event=>{
        event.preventDefault();const generation=++pageTestGeneration,button=document.getElementById('testExitButton'),result=document.getElementById('exitTestResult');
        button.disabled=true;button.textContent='正在测试…';result.textContent='正在通过所选出口请求页面…';
        try{const value=await api('/test','POST',{exit:document.getElementById('testExit').value,url:document.getElementById('testUrl').value});if(generation===pageTestGeneration)result.textContent=[value.exitName,'HTTP '+value.httpStatus+' '+value.statusText,'耗时 '+value.durationMs+' ms','已读取 '+value.checkedBytes+' 字节'+(value.truncated?'（已达到抽样上限）':''),value.finalUrl].join('\n');}
        catch(error){if(generation===pageTestGeneration)result.textContent=error.message;}
        finally{if(generation===pageTestGeneration){button.disabled=false;button.textContent='开始测试';}runtime();}
    };
    api('').then(value=>{data=value;showNodes();showEditor();showServices();return runtime();}).catch(feedback);
    setInterval(()=>{if(!document.hidden)runtime();},5000);
})();
