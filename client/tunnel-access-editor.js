(function(global){
    'use strict';
    const labels={read:'读取传输记录',sendText:'发送文本',sendRich:'发送富文本',sendFile:'发送文件',sendMarkdown:'发送Markdown',sendWebZip:'发送网页ZIP',delete:'删除记录',collaborativeEdit:'协同编辑',globalIntercom:'全局对讲机发声',groupVoice:'群语音通话'};
    const t=value=>global.TunnelI18n?.t(value)||value;
    const normalize=value=>Object.fromEntries(Object.keys(labels).map(key=>[key,(value?.[key]??(key==='sendMarkdown'?value?.sendText:key==='sendWebZip'?value?.sendFile:undefined))!==false]));
    const mounted=new WeakMap();
    function mount(container,options){
        const model={mode:options.draft?.mode||options.mode,permissions:normalize(options.draft?.permissions||options.permissions),version:options.version};mounted.set(container,model);
        const make=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=t(text);if(className)node.className=className;return node;};
        const card=make('section','','tunnel-access-record'),heading=make('div','','tunnel-access-heading'),name=make('strong'),id=make('code');
        name.textContent=options.deviceName||options.deviceId;id.textContent=options.deviceId;heading.append(name,id);
        const role=make('label','','tunnel-access-role'),admin=make('input');admin.type='checkbox';role.append(admin,document.createTextNode(t('设为隧道管理员（全部权限及分配权限）')));
        const grid=make('div','','tunnel-access-grid'),restore=make('button','恢复默认权限'),save=make('button','保存设备权限'),status=make('p');
        for(const [key,label]of Object.entries(labels)){
            const item=make('label'),input=make('input');input.type='checkbox';input.dataset.capability=key;
            input.onchange=()=>{model.permissions[key]=input.checked;model.mode='custom';changed();};item.append(input,document.createTextNode(t(label)));grid.append(item);
        }
        for(const button of [restore,save])button.type='button';status.setAttribute('role','status');
        function changed(){status.textContent=t('权限尚未保存');options.onChange?.({...model,permissions:{...model.permissions}});}
        function render(){
            const fixed=model.mode==='owner',all=fixed||model.mode==='administrator';admin.checked=all;admin.disabled=fixed;
            for(const input of grid.querySelectorAll('input')){input.checked=all||model.permissions[input.dataset.capability];input.disabled=all;}
            restore.hidden=save.hidden=fixed;if(fixed)status.textContent=t('创建者始终拥有全部权限');
        }
        admin.onchange=()=>{model.mode=admin.checked?'administrator':'custom';changed();render();};
        restore.onclick=()=>{model.mode='default';model.permissions=normalize(options.defaultPermissions);changed();render();};
        save.onclick=async()=>{
            for(const control of card.querySelectorAll('input,button'))control.disabled=true;
            status.textContent=t('正在保存权限...');
            try{const value=await options.onSave({...model,permissions:{...model.permissions}});if(mounted.get(container)===model)options.onSaved?.(value);}
            catch(error){if(mounted.get(container)===model)status.textContent=t(error.message==='device-permissions-changed'?'权限配置已更新，请重新打开后再编辑':'设备权限保存失败')+' ['+error.message+']';}
            finally{if(mounted.get(container)===model){restore.disabled=save.disabled=false;render();}}
        };
        card.append(heading,role,grid,restore,save,status);container.replaceChildren(card);render();
    }
    global.TunnelAccessEditor={mount,labels,reset:container=>mounted.delete(container)};
})(window);
