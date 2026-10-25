(function (global) {
    'use strict';
    const t = (value, ...args) => (global.TunnelI18n?.t(value) || value).replace(/\{(\d+)\}/g, (_m, i) => args[i] ?? _m);
    const accountLabel = (identity={}, internalId='') => {
        const name=identity.name || identity.username || internalId;
        const loginId=identity.telegramId || identity.accountTelegramId;
        return loginId ? `${name} / ${identity.provider==='mock' || identity.accountProvider==='mock' ? 'Mock' : 'Telegram'} ID ${loginId} · ${t('网盘内部 ID')} ${internalId}` : `${name} / ID ${internalId}`;
    };
    async function targetIdentity(record,accounts,signal) {
        const existing=accounts.accounts?.find(entry=>entry.identity?.id===record.target.accountId)?.identity;
        if(existing)return existing;
        // This module runs on the authenticated backend pages. Use their
        // existing read-only overview when the destination login is absent.
        if(global.fetch)try {
            const response=await global.fetch('/api/telegram/disk-admin/storage-overview',{cache:'no-store',signal});
            if(response.ok){const data=await response.json();for(const system of data.systems||[]){const user=system.users?.find(user=>(user.userId||user.id)===record.target.accountId);if(user)return user;}}
        }catch(error){if(signal?.aborted)throw error;}
        return null;
    }
    async function read(route, accountId = '', signal) {
        return global.DiskClient.raw(route, { accountId, diskSpace:'', requestBase:'/api/telegram/drive', signal });
    }
    // Backend UI composition only. Tasks and authentication remain in DiskClient.
    async function confirmView(record, signal) {
        const status = await read('/me', '', signal);
        let selected = status.identity?.id || '';
        try { selected = localStorage.getItem('telegram-drive-active-account') || selected; } catch (_) {}
        if (selected === record.target.accountId) return true;
        const state = await global.DiskClient.accountOperations(selected);
        if (signal?.aborted) return false;
        const user = status.accounts?.find(entry => entry.identity?.id === state.accountId)?.identity;
        const current = state.accountId ? accountLabel(user,state.accountId) : t('离线身份');
        const target = accountLabel({name:record.target.accountName,accountTelegramId:record.target.accountTelegramId,accountProvider:record.target.accountProvider},record.target.accountId);
        const kinds = {upload:'上传',copy:'复制',move:'移动',read:'读取',delete:'删除','transfer-history':'传输'};
        const tasks = state.operations.map(job => '• ' + t(kinds[job.type] || '网盘任务') + ' · ' + (job.title || job.message || job.operation_id)).join('\n');
        const activity = state.unverified ? t('无法核验当前账号的活动网盘任务，登录状态可能已失效。')
            : state.operations.length ? t('当前账号仍有以下活动网盘任务：') : t('当前账号没有正在执行的网盘任务。');
        const warning = t('切换后任务仍归原账号，当前界面将显示新账号的任务；查看原任务需切回原账号。浏览器上传请保持发起页面打开。');
        return global.confirm(t('当前前台账号：{0}\n文件所属账号：{1}', current, target) + '\n\n' + activity + (tasks ? '\n' + tasks : '') + '\n\n' + warning + '\n\n' + t('继续切换账号并前往查看？'));
    }
    async function openTask(input) {
        const dialog = document.createElement('dialog'); dialog.className = 'disk-saved-location';
        const heading = document.createElement('h3'); heading.textContent = t('已转存的网盘位置');
        const status = document.createElement('p'); status.setAttribute('role','status'); status.textContent = t('正在查询已转存的网盘位置');
        const details = document.createElement('div'), actions = document.createElement('div'); actions.className = 'disk-saved-location-actions';
        const close = document.createElement('button'); close.type = 'button'; close.textContent = t('关闭');
        const controller = new AbortController(); let closed = false;
        const dismiss = () => { closed = true; controller.abort(); dialog.close(); dialog.remove(); };
        close.onclick = dismiss; dialog.oncancel = event => { event.preventDefault(); dismiss(); };
        actions.append(close); dialog.append(heading,status,details,actions); document.body.append(dialog); dialog.showModal();
        const timeout = setTimeout(() => controller.abort(), 20000);
        let record;
        try {
            record = await global.DiskPendingSave.prepareServer(input);
            if (closed) return;
            if (record.status !== 'completed') { dismiss(); return { record, opened:global.DiskPendingSave.open(record) }; }
            const checked = await global.DiskPendingSave.inspectSaved(record);
            if (closed) return;
            const accounts = await read('/accounts', '', controller.signal);
            const user = await targetIdentity(record,accounts,controller.signal);
            const target = { ...record.target, accountName:user?.name || user?.username || record.target.accountName || record.target.accountId,
                accountTelegramId:user?.telegramId || record.target.accountTelegramId || '',accountProvider:user?.provider || record.target.accountProvider || '' };
            // Persist display metadata with the receipt, never change its identity.
            if (JSON.stringify(target) !== JSON.stringify(record.target)) record = await global.DiskPendingSave.update(record.id,{target});
            if (closed) return;
            const add = (label, value) => { const line = document.createElement('p'), title = document.createElement('strong'), text = document.createElement('span'); title.textContent=t(label)+': ';text.textContent=value;line.append(title,text);details.append(line); };
            add('账号', accountLabel({name:target.accountName,accountTelegramId:target.accountTelegramId,accountProvider:target.accountProvider},target.accountId));
            add('网盘分区', `${target.partitionName || t('名称未记录')} / ID ${target.partitionId || target.diskSpace || t('未记录')}`);
            const files = checked.files?.length ? checked.files : record.result?.items?.length ? record.result.items : [record.file];
            for (const file of files) add('完整路径', '/' + [target.path, file.name || record.file.name].filter(Boolean).join('/').replace(/^\/+/,''));
            status.textContent = checked.state === 'saved' ? t('已核验文件仍在原保存位置') : t('显示上次保存位置；登录目标账号后继续核验文件。');
            const view = document.createElement('button'); view.type='button'; view.textContent=t('前往查看'); view.className='primary';
            view.onclick=async()=>{
                if(view.disabled)return;view.disabled=true;
                const check = new AbortController(), deadline=setTimeout(()=>check.abort(),20000);
                const cancel=()=>check.abort();controller.signal.addEventListener('abort',cancel,{once:true});
                try {
                    status.textContent=t('正在检查当前账号及网盘任务…');
                    const agreed=await confirmView(record,check.signal);
                    if(closed)return;
                    if(!agreed){status.textContent=t('已取消前往查看，未切换账号。');return;}
                    const result=global.DiskPendingSave.open(record);
                    // A normal link remains available if popup creation is blocked.
                    const link=document.createElement('a');link.href=result.url;link.target='_blank';link.rel='noopener';link.textContent=t('打开网盘查看文件');
                    status.replaceChildren(link);
                }catch(error){if(!closed)status.textContent=t('未打开网盘，请重试')+' ['+error.message+']';}
                finally{clearTimeout(deadline);controller.signal.removeEventListener('abort',cancel);view.disabled=false;}
            };
            actions.prepend(view);
        } catch(error) { if(!closed)status.textContent=t('网盘位置查询未完成，请关闭后重试')+' ['+error.message+']'; }
        finally { clearTimeout(timeout); }
    }
    global.DiskSavedLocation = { openTask, confirmView, accountLabel };
})(window);
