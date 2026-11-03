(function (global) {
    'use strict';
    const labels = { read: '读取传输记录', sendText: '发送文本', sendRich: '发送富文本', sendFile: '发送文件', sendMarkdown: '发送Markdown', sendWebZip: '发送网页ZIP', delete: '删除记录', collaborativeEdit: '协同编辑', globalIntercom: '全局对讲机发声', groupVoice: '群语音通话' };
    const t = value => global.TunnelI18n?.t(value) || value;
    const mounted = new WeakMap();
    const normalize = value => Object.fromEntries(Object.keys(labels).map(key => [key,(value?.[key] ?? (key === 'sendMarkdown' ? value?.sendText : key === 'sendWebZip' ? value?.sendFile : undefined)) !== false]));
    function mount(container, options) {
        const signature = JSON.stringify([options.ownerDeviceId,options.managementDevices,options.devicePermissionRecords,options.knownDevices,options.editable]);
        const current = mounted.get(container);
        if (current?.signature === signature) return;
        if (current?.dirty) { current.stale(); return; }
        const model = { signature, dirty: false }; mounted.set(container,model);
        const records = new Map();
        for (const record of options.devicePermissionRecords || []) records.set(record.deviceId,{...record,isAdmin:false,permissions:normalize(record.permissions)});
        for (const record of options.managementDevices || []) records.set(record.deviceId,{...record,isAdmin:true,permissions:normalize(record.permissions)});
        records.delete(options.ownerDeviceId);
        const make = (tag,text,className) => { const node=document.createElement(tag);if(text)node.textContent=t(text);if(className)node.className=className;return node; };
        const picker=make('div','','tunnel-access-picker'),select=make('select'),manual=make('input'),add=make('button','添加设备'),list=make('div','','tunnel-access-records'),save=make('button','保存设备权限'),status=make('p');
        select.setAttribute('aria-label',t('选择在线设备'));manual.setAttribute('aria-label',t('设备 ID'));manual.placeholder=t('或粘贴设备 ID');
        const placeholder=make('option','选择在线设备');placeholder.value='';select.append(placeholder);
        for(const device of options.knownDevices || []) {if(device.deviceId===options.ownerDeviceId)continue;const option=make('option');option.value=device.deviceId;option.textContent=(device.deviceName||device.deviceId)+' · '+device.deviceId;select.append(option);}
        picker.append(select,manual,add);container.replaceChildren(picker,list,save,status);
        for(const button of [add,save])button.type='button';
        select.disabled=manual.disabled=add.disabled=!options.editable;save.hidden=!options.editable;status.setAttribute('role','status');
        model.stale=()=>{save.disabled=true;status.textContent=t('权限配置已更新，请重新打开后再编辑');};
        function render() {
            list.replaceChildren();
            if(!records.size)list.append(make('p','尚未单独配置设备权限'));
            for(const record of records.values()) {
                const card=make('section','','tunnel-access-record'),heading=make('div','','tunnel-access-heading'),name=make('strong');name.textContent=record.deviceName||record.deviceId;
                const id=make('code');id.textContent=record.deviceId;heading.append(name,id);
                const role=make('label','','tunnel-access-role'),checkbox=make('input');checkbox.type='checkbox';checkbox.checked=record.isAdmin;checkbox.disabled=!options.editable;
                role.append(checkbox,document.createTextNode(t('设为隧道管理员（全部权限及分配权限）')));
                checkbox.onchange=()=>{record.isAdmin=checkbox.checked;model.dirty=true;render();};
                const grid=make('div','','tunnel-access-grid');
                for(const [key,label]of Object.entries(labels)) {
                    const item=make('label'),input=make('input');input.type='checkbox';input.dataset.capability=key;
                    input.checked=record.isAdmin||record.permissions[key]!==false;input.disabled=!options.editable||record.isAdmin;
                    input.onchange=()=>{record.permissions[key]=input.checked;model.dirty=true;};item.append(input,document.createTextNode(t(label)));grid.append(item);
                }
                const remove=make('button','恢复默认权限');remove.type='button';remove.disabled=!options.editable;remove.onclick=()=>{records.delete(record.deviceId);model.dirty=true;render();};
                card.append(heading,role,grid,remove);list.append(card);
            }
        }
        add.onclick=()=>{
            const deviceId=String(manual.value||select.value).trim();
            if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)){status.textContent=t('请选择设备或输入有效设备 ID');return;}
            if(deviceId===options.ownerDeviceId){status.textContent=t('创建者始终拥有全部权限');return;}
            if(!records.has(deviceId))records.set(deviceId,{deviceId,deviceName:(options.knownDevices||[]).find(device=>device.deviceId===deviceId)?.deviceName||'',isAdmin:false,permissions:normalize(options.permissions)});
            manual.value='';model.dirty=true;render();
        };
        save.onclick=async()=>{
            const controls=[...container.querySelectorAll('input,select,button')].map(control=>[control,control.disabled]);
            for(const [control] of controls)control.disabled=true;
            status.textContent=t('正在保存权限...');
            const managementDevices={},devicePermissions={};
            for(const record of records.values()){const {isAdmin,...value}=record;(isAdmin?managementDevices:devicePermissions)[record.deviceId]=value;}
            try{await options.onSave({managementDevices,devicePermissions});model.dirty=false;mounted.delete(container);status.textContent=t('设备权限已保存');options.onSaved?.();}
            catch(error){status.textContent=t('设备权限保存失败')+' ['+error.message+']';}
            finally{for(const [control,disabled] of controls)if(control.isConnected)control.disabled=disabled;}
        };
        render();
    }
    global.TunnelAccessEditor={mount,labels,reset:container=>mounted.delete(container)};
})(window);
