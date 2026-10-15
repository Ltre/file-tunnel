'use strict';
(function(){
    const kind=document.body.dataset.records, list=document.getElementById('records'), status=document.getElementById('status'), more=document.getElementById('more');let offset=0,busy=false;
    const node=(tag,text)=>{const value=document.createElement(tag);value.textContent=String(text??'');return value;};
    async function load(reset=false){if(busy)return;busy=true;status.textContent='正在读取…';
        try{const response=await fetch(kind==='magnets'?'/api/magnets?limit=100&offset='+(reset?0:offset):'/api/devices',{cache:'no-store'});if(!response.ok)throw Error('读取失败（HTTP '+response.status+'）');const data=await response.json(), rows=data[kind]||[];
            if(reset){offset=0;list.replaceChildren();}for(const row of rows){const card=node('article','');
                if(kind==='magnets'){card.append(node('h2',row.asset?.name||row.assetId),node('p',`隧道：${row.shortCode||row.sessionId} · 文件 ID：${row.assetId}`),node('p',`大小：${row.asset?.size||0} 字节 · 类型：${row.asset?.type||'未知'}`),node('p',`状态：${row.revoked?'隧道已删除，链接已停用':row.seedCount?'有在线供源':'链接已登记，暂无在线供源'} · 下载触发次数：${row.downloadCount||0}`));
                    const shares=node('details',''),summary=node('summary',`分享记录（${row.shares?.length||1}）`);shares.append(summary);
                    for(const share of row.shares||[{deviceName:row.createdByDeviceName,deviceId:row.createdByDeviceId,sharedAt:row.createdAt}])shares.append(node('p',`${new Date(share.sharedAt).toLocaleString()} · ${share.deviceName||'未命名设备'} · ${share.deviceId||'未知设备'} · ${share.asset?.name||row.asset?.name||''} · ${share.asset?.size??row.asset?.size??0} 字节 · ${share.asset?.type||row.asset?.type||'未知类型'}`));card.append(shares);
                    const link=node('a','打开磁链');link.href='/magnet/'+encodeURIComponent(row.id);link.target='_blank';link.rel='noopener';const copy=node('button','复制磁链');copy.onclick=()=>navigator.clipboard.writeText(new URL(link.href,location.origin).href).then(()=>{copy.textContent='已复制';}).catch(()=>{status.textContent='复制失败，请手动复制链接';});card.append(link,copy);
                }else{card.append(node('h2',row.deviceName||'未命名设备'),node('p',`设备 ID：${row.deviceId||row.key} · ${row.online?'在线':'离线'} · ${row.active?'活跃':'不活跃'}`),node('p',`隧道：${row.sessionId||'未加入'}`),node('p',`外网/IP：${row.ip||row.externalIp||'-'} · 内网：${row.localIp||'-'}`),node('p',row.deviceModel||row.userAgent||''),node('p','最后访问：'+new Date(row.lastAccess).toLocaleString()));}
                list.append(card);}offset+=rows.length;more.hidden=kind!=='magnets'||rows.length<100;status.textContent=offset?'已显示 '+offset+' 条记录':'暂无记录';
        }catch(error){status.textContent=error.message;}finally{busy=false;}}
    document.getElementById('reload').onclick=()=>load(true);more.onclick=()=>load();load(true);
})();
