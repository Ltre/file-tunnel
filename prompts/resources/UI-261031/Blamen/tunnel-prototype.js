/* 页面结构和样式来自当前首页；交互使用内存中的演示数据，不连接后端。 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const shell = $('appShell');
  if (new URLSearchParams(location.search).get('base') === '1') delete document.body.dataset.prototypeSkin;

  function makeQr() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox','0 0 41 41'); svg.setAttribute('width','180'); svg.setAttribute('height','180');
    svg.setAttribute('aria-label','示例二维码'); svg.setAttribute('shape-rendering','crispEdges');
    const back = document.createElementNS(ns,'rect'); back.setAttribute('width','41'); back.setAttribute('height','41'); back.setAttribute('fill','#fff'); svg.append(back);
    function dot(x,y) { const r=document.createElementNS(ns,'rect'); r.setAttribute('x',x+2); r.setAttribute('y',y+2); r.setAttribute('width','1'); r.setAttribute('height','1'); r.setAttribute('fill','#111827'); svg.append(r); }
    function finder(x,y) { for(let r=0;r<7;r++) for(let c=0;c<7;c++) if(!r||!c||r===6||c===6||(r>1&&r<5&&c>1&&c<5)) dot(x+c,y+r); }
    let seed=92097;
    for(let y=0;y<37;y++) for(let x=0;x<37;x++) { seed=(seed*1664525+1013904223)>>>0; if(!((x<8&&y<8)||(x>28&&y<8)||(x<8&&y>28))&&((seed>>>27)&1)) dot(x,y); }
    finder(0,0);finder(30,0);finder(0,30);$('qrcode').append(svg);
  }
  makeQr();
  $('sessionRemarkRow').hidden=false;$('sessionRemark').textContent='我的隧道';
  $('sessionId').textContent='6732a50e...';$('deviceId').textContent='df2b289e...';$('onlineCount').textContent='1';$('shortCode').textContent='QQQQQ';
  $('deviceList').innerHTML='<div class="device-item"><div class="icon">👤</div><div class="info"><div class="name">📱 设备-ad98 (我)</div><div class="status">在线</div></div></div>';
  $('nearbyDeviceList').innerHTML='<div class="contact-empty">暂未发现同网络设备，可点击“增强发现”授权位置</div>';
  $('contactList').innerHTML='<div class="contact-empty">还没有关注设备。点击设备名称可查看资料并关注</div>';
  $('editor').textContent='55';
  const actions='<div class="message-record-actions"><button type="button" class="message-record-menu-trigger" title="记录操作" aria-label="打开传输记录操作菜单">☰</button></div>';
  $('chatMessages').innerHTML=
    '<div class="message collection-record" data-demo-record="collection"><div class="message-header"><span>设备-ad98</span><span>2026-08-14 09:37:02</span></div><div class="message-bubble collection-message"><div class="collection-preview">'+
    ['a','b','c','d'].map(v=>'<div class="collection-preview-tile" role="button" tabindex="0"><img src="sample-document-'+v+'.svg" alt="示例合辑文件"></div>').join('')+
    '</div><div class="collection-meta">4 个文件 · 8.64 MB</div></div>'+actions+'</div>'+
    '<div class="message own"><div class="message-header"><span>📱 设备-ad98</span><span>2026-08-14 09:37:20</span><span class="message-record-sns-badge">★ SNS</span></div><div class="message-bubble">https://youtube.com/shorts/QYSvKdA4C3M</div>'+actions+'</div>'+
    '<div class="message file-record" data-demo-record="photo"><div class="message-header"><span>SNS媒体文件</span><span>2026-08-14 09:39:33</span></div><div class="message-bubble"><div class="media-preview"><img src="sample-photo.svg" alt="示例图片"></div><div class="file-size media-file-size">152.42 KB</div></div>'+actions+'</div>'+
    '<div class="message" data-demo-record="rich"><div class="message-header"><span>设备-ad98</span><span>2026-08-14 09:42:08</span></div><div class="message-bubble rich-preview"><strong>📝 富文本</strong><div class="rich-preview-content">下一次出发 · 整理照片与还没完成的想法。</div></div>'+actions+'</div>';

  const tools=$('settingsToolGrid'), originalTools=document.querySelector('.left-panel .session-tools');
  while(originalTools.firstChild) tools.appendChild(originalTools.firstChild);
  const rotate=document.createElement('button');rotate.className='btn btn-secondary';rotate.type='button';rotate.textContent='修改隧道短码';tools.append(rotate);
  $('tunnelPermissionGrid').innerHTML=['读取传输记录','发送文本','发送富文本','发送文件','删除记录','协同编辑'].map(v=>'<label class="tunnel-permission-option"><input type="checkbox" checked> '+v+'</label>').join('');
  $('appLanguageSelect').innerHTML='<option>简体中文</option>';

  function closeShortCode() { $('shortCodeSwitchMenu').hidden=true;$('shortCodeSwitchBtn').setAttribute('aria-expanded','false'); }
  $('shortCodeSwitchBtn').addEventListener('click',event=>{
    event.stopPropagation();
    const menu=$('shortCodeSwitchMenu');
    if(!menu.hidden) { closeShortCode(); return; }
    menu.innerHTML='<button type="button" class="short-code-switch-item is-current"><strong>QQQQQ · 我的隧道</strong></button><button type="button" class="short-code-switch-item"><strong>K7M2P · 灵感工作室</strong></button><button type="button" class="short-code-switch-item"><strong>N8Q4T · 周末放映室</strong></button>';
    menu.style.setProperty('--short-code-menu-width',Math.max(0,event.currentTarget.closest('.panel').clientWidth-20)+'px');
    menu.hidden=false;$('shortCodeSwitchBtn').setAttribute('aria-expanded','true');
  });
  $('shortCodeSwitchMenu').addEventListener('click',event=>{
    const option=event.target.closest('.short-code-switch-item');if(!option)return;
    const code=option.querySelector('strong').textContent.slice(0,5);$('shortCode').textContent=code;closeShortCode();
  });
  document.addEventListener('click',event=>{if(!event.target.closest('.short-code-switch'))closeShortCode();});

  $('connectionHeaderMenuBtn').addEventListener('click',event=>{event.stopPropagation();$('connectionHeaderMenu').hidden=!$('connectionHeaderMenu').hidden;});
  document.addEventListener('click',event=>{if(!event.target.closest('.connection-header-menu-wrap'))$('connectionHeaderMenu').hidden=true;});
  $('tunnelSettingsBtn').onclick=()=>{$('tunnelSettingsLayer').hidden=false;};
  $('closeTunnelSettingsBtn').onclick=()=>{$('tunnelSettingsLayer').hidden=true;};
  $('tunnelSettingsLayer').onclick=event=>{if(event.target===$('tunnelSettingsLayer'))$('tunnelSettingsLayer').hidden=true;};
  const themes=['lumen','orbit','classic','atelier','social'];
  function setTheme(value) { document.body.dataset.theme=themes.includes(value)?value:'classic';document.querySelectorAll('[data-theme]').forEach(node=>node.classList.toggle('active',node.dataset.theme===value)); }
  $('cycleThemeBtn').onclick=()=>setTheme(themes[(themes.indexOf(document.body.dataset.theme)+1)%themes.length]);
  document.querySelectorAll('#themeSwitcher [data-theme],#themeQuickMenu [data-theme]').forEach(button=>button.onclick=()=>setTheme(button.dataset.theme));
  setTheme('lumen');

  function openRecordMenu(trigger) {
    document.querySelector('.message-record-action-menu-layer')?.remove();
    const layer=document.createElement('div');layer.className='message-record-action-menu-layer';
    const menu=document.createElement('div');menu.className='message-record-action-menu';menu.setAttribute('role','menu');
    menu.innerHTML='<div class="message-record-action-menu-handle" aria-hidden="true"></div>';
    [['ℹ','详情'],['🔗','复制此锚点'],['⧉','复制文本'],['☆','收藏'],['✎','备注'],['✴↗','使用光媒分享'],['⎇','发到其他隧道'],['streaming.png','创建串流台'],['streaming.png','添加到串流台'],['☁','保存到网盘'],['🗑','删除']].forEach(([icon,label])=>{
      const b=document.createElement('button');b.type='button';b.className='history-action';b.innerHTML='<span class="record-action-icon"></span><span></span>';if(icon==='streaming.png'){const img=document.createElement('img');img.src=icon;img.alt='';b.firstChild.append(img);}else b.firstChild.textContent=icon;b.lastChild.textContent=label;menu.appendChild(b);
    });
    layer.append(menu);document.body.append(layer);
    layer.addEventListener('click',event=>{
      const action=event.target.closest('.history-action');
      if(event.target===layer||action)layer.remove();
      if(action?.lastChild.textContent==='详情')showDetails();
    });
    if(!matchMedia('(max-width:767px)').matches){const r=trigger.getBoundingClientRect(),m=menu.getBoundingClientRect();menu.style.left=Math.min(innerWidth-m.width-8,Math.max(8,r.right-m.width))+'px';menu.style.top=(r.bottom+5+m.height<=innerHeight-8?r.bottom+5:Math.max(8,r.top-m.height-5))+'px';}
  }
  $('chatMessages').addEventListener('click',event=>{
    const trigger=event.target.closest('.message-record-menu-trigger');if(trigger){event.stopPropagation();openRecordMenu(trigger);return;}
    const message=event.target.closest('[data-demo-record]');if(!message)return;
    if(message.dataset.demoRecord==='rich'){$('richViewerContent').innerHTML='<h2>下一次出发</h2><p>整理照片与还没完成的想法。</p>';$('richViewer').classList.add('active');return;}
  });
  function showDetails(){
    document.querySelector('#transferRecordDetailsLayer')?.remove();
    const layer=document.createElement('div');layer.id='transferRecordDetailsLayer';layer.className='transfer-record-details-layer';
    layer.innerHTML='<section class="transfer-record-details-panel" role="dialog" aria-modal="true"><header class="transfer-record-details-header"><div><span class="transfer-record-details-kicker">单文件</span><h2>传输记录详情</h2></div><button type="button" class="transfer-record-details-close" aria-label="关闭">×</button></header><div class="transfer-record-details-body"><dl class="transfer-record-details-summary"><div><dt>记录 ID</dt><dd>sample-message</dd></div><div><dt>关联隧道</dt><dd>QQQQQ · 我的隧道</dd></div><div><dt>发送者</dt><dd>设备-ad98</dd></div><div><dt>发送时间</dt><dd>2026-08-14 09:39:33</dd></div><div><dt>备注</dt><dd>无</dd></div></dl><section class="transfer-record-details-files"><h3>文件信息 · 1</h3><article class="transfer-record-detail-file"><strong>1. 图片.jpg</strong><span>image/jpeg · 152.42 KB</span><span>缓存状态：浏览器缓存完整</span><span>文件 ID：sample-photo</span></article></section><details class="transfer-record-raw-details"><summary>记录元数据</summary><pre>{ "id": "sample-message", "type": "file" }</pre></details></div><footer class="transfer-record-details-actions"><button type="button" data-record-locate>定位到记录</button><button type="button" data-record-copy>复制记录链接</button></footer></section>';
    layer.onclick=event=>{if(event.target===layer||event.target.closest('.transfer-record-details-close,[data-record-locate]'))layer.remove();};document.body.append(layer);
  }
  function showResources(){
    const layer=$('resourceBrowserLayer');if(layer.parentElement!==document.body)document.body.appendChild(layer);layer.hidden=false;layer.classList.remove('is-minimized');layer.classList.add('active');
    layer.innerHTML='<section class="modal resource-browser-modal" role="dialog" aria-label="会话资源浏览器"><div class="resource-browser-header"><div class="resource-browser-header-main"><h3>会话资源浏览器</h3><button type="button" class="resource-browser-refresh">↻ 刷新</button></div><div class="resource-browser-header-actions"><button type="button" class="resource-browser-minimize" aria-label="最小化资源管理器">−</button><button type="button" class="resource-browser-close" aria-label="关闭资源浏览器">×</button></div></div><div class="resource-browser-controls"><button type="button" class="resource-action">挂载本机目录</button><button type="button" class="resource-action">关联本机文件</button><button type="button" class="resource-action">Telegram 文件防失联检测及修复</button><input type="search" placeholder="按名称或格式筛选资源" aria-label="筛选资源"><select aria-label="资源状态筛选"><option>全部资源</option><option>有引用</option><option>未引用</option><option>缓存缺失</option><option>已收藏</option><option>Telegram 渠道</option></select></div><div class="resource-browser-summary">共 2 项资源，本机缓存 152.42 KB，当前显示 2 项。</div><section class="resource-browser-mounts"><strong>本机资源挂载 · 0</strong><span> 尚未挂载本机目录</span></section><div class="resource-browser-list"><article class="resource-browser-item"><div class="resource-browser-main"><div><div class="resource-browser-name">图片.jpg</div><div class="resource-browser-meta">152.42 KB · image/jpeg</div></div><div class="resource-browser-tags"><span class="resource-tag">文件</span><span class="resource-tag protected">引用 1</span><span class="resource-tag">已缓存</span></div></div><div class="resource-browser-references"><div class="resource-reference-title">引用位置</div><div class="resource-reference-list"><button type="button" class="resource-reference-button">聊天文件 09:39</button></div></div><div class="resource-browser-actions"><button type="button" class="resource-action">下载</button><button type="button" class="resource-action">清除缓存</button></div></article><article class="resource-browser-item"><div class="resource-browser-main"><div><div class="resource-browser-name">示例合辑文件.png</div><div class="resource-browser-meta">2.16 MB · image/png</div></div><div class="resource-browser-tags"><span class="resource-tag">文件</span><span class="resource-tag protected">引用 1</span></div></div><div class="resource-browser-references"><div class="resource-reference-title">引用位置</div><div class="resource-reference-list"><button type="button" class="resource-reference-button">合辑文件 09:37</button></div></div></article></div></section>';
    layer.onclick=event=>{
      if(event.target===layer||event.target.closest('.resource-browser-close')){layer.hidden=true;layer.classList.remove('active','is-minimized');layer.replaceChildren();return;}
      const minimize=event.target.closest('.resource-browser-minimize');if(minimize){const minimized=layer.classList.toggle('is-minimized');layer.classList.toggle('active',!minimized);minimize.textContent=minimized?'□':'−';}
    };
  }
  function showBackup(){
    const overlay=document.createElement('div');overlay.className='send-mode-overlay';
    overlay.innerHTML='<div class="send-mode-dialog" role="dialog" aria-modal="true"><h3>传输记录备份</h3><p>元信息备份体积小，完整备份会包含本机现有的全部文件数据。</p><div class="send-mode-actions"><button class="btn btn-secondary" data-action="metadata">导出元信息</button><button class="btn btn-primary" data-action="full">导出完整备份</button><button class="btn btn-secondary" data-action="import">导入备份</button></div></div>';
    overlay.onclick=event=>{if(event.target===overlay||event.target.closest('[data-action]'))overlay.remove();};document.body.append(overlay);
  }
  function showCleanup(){
    const layer=document.createElement('div');layer.className='modal-overlay active';
    layer.innerHTML='<div class="modal"><h3>清理垃圾缓存</h3><p>可清理游离缓存和串流台观看缓存，仍被引用的供源文件缓存会保留。</p><p>2 · 1.24 MB</p><ul style="max-height:200px;overflow:auto;padding-left:20px;text-align:left"><li>示例图片.png (152.42 KB)</li><li>示例视频.mp4 (1.09 MB)</li></ul><div class="modal-actions"><button class="btn btn-secondary" id="cancelGarbageCleanup">取消</button><button class="btn btn-primary" id="confirmGarbageCleanup">清理 2 项</button></div></div>';
    layer.onclick=event=>{if(event.target===layer||event.target.closest('#cancelGarbageCleanup,#confirmGarbageCleanup'))layer.remove();};document.body.append(layer);
  }
  $('settingsToolGrid').addEventListener('click',event=>{if(event.target.closest('button'))$('tunnelSettingsLayer').hidden=true;},true);
  $('resourceBrowserBtn').onclick=showResources;$('connectionResourceBrowserBtn').onclick=()=>{$('connectionHeaderMenu').hidden=true;showResources();};
  $('historyBackupBtn').onclick=showBackup;$('garbageCleanupBtn').onclick=showCleanup;
  $('notificationCenterBtn').onclick=()=>{
    $('connectionHeaderMenu').hidden=true;let center=$('notificationCenter');
    if(!center){center=document.createElement('section');center.id='notificationCenter';center.className='notification-center';center.innerHTML='<header><button type="button" data-notification-close aria-label="关闭">←</button><div><strong>通知中心</strong><span data-notification-count hidden></span></div><button type="button" data-notification-clear>清空已读</button></header><main><div class="notification-center-list"><article class="notification-card"><div class="notification-card-head"><strong>设备通知</strong><time>2026/10/31 18:30</time></div><p>示例设备已上线。</p></article></div></main>';document.body.append(center);center.querySelector('[data-notification-close]').onclick=()=>{center.hidden=true;center.classList.remove('active');};center.querySelector('[data-notification-clear]').onclick=()=>{center.querySelector('.notification-center-list').innerHTML='<div class="notification-center-empty">暂无设备通知</div>';};}
    center.hidden=false;center.classList.add('active');
  };
  $('deviceList').querySelector('.name').onclick=()=>{
    $('deviceProfileTitle').textContent='设备-ad98 (我)';
    $('deviceProfileQr').innerHTML=$('qrcode').innerHTML;$('deviceProfileQr').querySelector('svg').setAttribute('width','112');$('deviceProfileQr').querySelector('svg').setAttribute('height','112');
    $('deviceProfileFields').innerHTML='<div class="profile-field"><strong>我的备注</strong><div class="profile-field-value">未设置</div></div><div class="profile-field"><strong>设备ID</strong><div class="profile-field-value">df2b289e...</div></div><div class="profile-field"><strong>型号</strong><div class="profile-field-value">PC</div></div><div class="profile-field"><strong>内网IP</strong><div class="profile-field-value">—</div></div><div class="profile-field"><strong>外网IP</strong><div class="profile-field-value">—</div></div><div class="profile-field"><strong>主页链接</strong><div class="profile-field-value">—</div></div>';
    $('deviceProfileModal').classList.add('active');
  };
  $('closeDeviceProfileBtn').onclick=()=>$('deviceProfileModal').classList.remove('active');
  $('deviceProfileModal').onclick=event=>{if(event.target===$('deviceProfileModal'))$('deviceProfileModal').classList.remove('active');};
  $('closeRichViewer').onclick=()=>$('richViewer').classList.remove('active');
  $('richViewer').onclick=event=>{if(event.target===$('richViewer'))$('richViewer').classList.remove('active');};
  $('dropZone').onclick=()=>$('fileInput').click();
  $('sendTextBtn').onclick=()=>{const value=$('textInput').value.trim();if(!value)return;const node=document.createElement('div');node.className='message own';const bubble=document.createElement('div');bubble.className='message-bubble';bubble.textContent=value;node.append(bubble);$('chatMessages').append(node);$('textInput').value='';$('chatMessages').scrollTop=$('chatMessages').scrollHeight;};
  $('clearEditorBtn').onclick=()=>{$('editor').textContent='';};
  document.querySelectorAll('.toolbar-btn[data-cmd]').forEach(button=>button.onclick=()=>{$('editor').focus();document.execCommand(button.dataset.cmd);});
  $('workspaceCollabOpen').onclick=()=>shell.classList.add('workspace-collab-open');
  $('workspaceCollabClose').onclick=()=>shell.classList.remove('workspace-collab-open');
  function setMobile(view){shell.dataset.mobileView=view;document.querySelectorAll('.mobile-workspace-button').forEach(button=>{const active=button.dataset.mobileView===view;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});}
  function controlCenter(){
    const layer=document.createElement('div');layer.className='modal-overlay active control-center-overlay';
    layer.innerHTML='<div class="control-center"><div class="control-center-tiles" data-control-side="before"></div><div class="modal session-switcher-modal" data-control-panel><button class="session-switcher-close" type="button" aria-label="关闭">×</button><h3>切换隧道</h3><button class="session-switch-scroll" type="button" data-scroll="-1" aria-label="向上滚动" hidden>⌃</button><div class="session-switcher-list"></div><button class="session-switch-scroll" type="button" data-scroll="1" aria-label="向下滚动" hidden>⌄</button></div><div class="control-center-tiles" data-control-side="after"></div></div>';
    const list=layer.querySelector('.session-switcher-list');
    ['QQQQQ · 我的隧道','K7M2P · 灵感工作室','N8Q4T · 周末放映室','B6N3D · 隧道四','C4T7A · 隧道五','R2F5H · 隧道六','V9P3L · 隧道七'].forEach((label,index)=>{const b=document.createElement('button');b.className='session-tool session-switch-item'+(index?'':' is-current');b.style.cssText='width:100%;justify-content:flex-start;margin:6px 0';b.innerHTML='<strong></strong><br><small>2026/10/31 18:30:00</small>';b.querySelector('strong').textContent=label;list.append(b);});
    const area=layer.querySelector('[data-control-side="before"]');
    [['refresh','↻','mobileForceRefreshBtn'],['magnet','🧲⇩','magnetCacheBtn'],['theme','◐','cycleThemeBtn'],['settings','⚙','tunnelSettingsBtn'],['leave','◉','leaveTunnelPanelBtn'],['scan','▩','scanTunnelCodeBtn'],['light','✴↗','receiveLightBtn'],['resources','ꕡ','resourceBrowserBtn'],['workshop','🌐','webWorkshopBtn'],['notifications','🔔','notificationCenterBtn'],['disk','▤','telegramDriveBtn'],['music','♪','topbarMusicBtn'],['streaming','◉','streamingConsoleBtn']].forEach(([id,icon,target])=>{const b=document.createElement('button');b.className='control-center-tile';b.dataset.controlTile=id;b.textContent=icon;b.onclick=()=>{if(id==='theme'){$(target)?.click();return;}layer.remove();$(target)?.click();};area.append(b);});
    layer.addEventListener('click',event=>{if(!event.target.closest('.control-center-tile,[data-control-panel]')||event.target.closest('.session-switcher-close,.session-switch-item'))layer.remove();});
    document.body.append(layer);
    const scrollButtons=layer.querySelectorAll('.session-switch-scroll');const update=()=>{const overflow=list.scrollHeight>list.clientHeight+2;scrollButtons.forEach(button=>button.hidden=!overflow);};
    scrollButtons.forEach(button=>button.onclick=()=>list.scrollBy({top:Number(button.dataset.scroll)*Math.max(120,list.clientHeight*.75),behavior:'smooth'}));
    requestAnimationFrame(update);
  }
  document.querySelectorAll('.mobile-workspace-button').forEach(button=>button.addEventListener('click',()=>{if(button.dataset.mobileView==='chat'&&shell.dataset.mobileView==='chat')controlCenter();else setMobile(button.dataset.mobileView);}));
  let swipe=null;shell.addEventListener('touchstart',event=>{if(event.touches.length!==1||event.target.closest('button,input,textarea,[contenteditable]'))return;swipe={x:event.touches[0].clientX,y:event.touches[0].clientY};},{passive:true});
  shell.addEventListener('touchend',event=>{if(!swipe||innerWidth>767)return;const dx=event.changedTouches[0].clientX-swipe.x,dy=event.changedTouches[0].clientY-swipe.y;swipe=null;if(Math.abs(dx)<75||Math.abs(dx)<Math.abs(dy)*1.5)return;const views=['devices','chat','editor'];setMobile(views[Math.max(0,Math.min(2,views.indexOf(shell.dataset.mobileView)+(dx<0?1:-1)))]);},{passive:true});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeShortCode();$('connectionHeaderMenu').hidden=true;$('tunnelSettingsLayer').hidden=true;$('filePreviewViewer').classList.remove('active');document.querySelector('.message-record-action-menu-layer')?.remove();document.querySelector('.control-center-overlay')?.remove();}});
  const initial=new URLSearchParams(location.search).get('view');if(['devices','chat','editor'].includes(initial))setMobile(initial);
})();
