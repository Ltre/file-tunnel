/* Isolated design staging: real layout and component renderers, fabricated content. */
window.DESIGN_READY=false;
const state={deviceId:'design-device',dataChannels:new Map([['phone',true],['tablet',true]])};
const mediaController=null;
function normalizeContactProfile(d){return d;}
function getLocalDeviceRemark(){return null;}
function getDeviceDisplayName(d){return d.name;}
function makeDeviceNameInteractive(node,d){node.classList.add('device-name-button');node.setAttribute('role','button');node.title=d.name;}
function startContactVoiceCall(){}function startIntercomWithDevice(){}
const sampleCode=`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>周末的灵感手记</title>
  <link rel="stylesheet" href="assets/style.css">
</head>
<body>
  <main class="journal">
    <header>
      <p class="eyebrow">FIELD NOTES / 2026</p>
      <h1>把生活里喜欢的片刻，收集起来。</h1>
      <p>照片、音乐和一些还没完成的想法。</p>
    </header>
    <figure>
      <img src="assets/blue-hour.png" alt="蓝调时刻">
      <figcaption>October 26 · After the blue</figcaption>
    </figure>
  </main>
</body>
</html>`;
function fillHome(){
 document.getElementById('tunnelStartupLoading')?.remove();document.getElementById('sessionLanding').hidden=true;document.getElementById('appShell').hidden=false;document.getElementById('tunnelTopbar').hidden=false;
 document.getElementById('appShell').dataset.mobileView='chat';
 document.getElementById('sessionRemarkRow').hidden=false;document.getElementById('sessionRemark').textContent='灵感工作室';
 document.getElementById('sessionId').textContent='studio-8f7b2c41';document.getElementById('deviceId').textContent='design-device';document.getElementById('shortCode').textContent='K7M2P';document.getElementById('onlineCount').textContent='3';
 new QRCode(document.getElementById('qrcode'),{text:'https://example.invalid/?code=K7M2P',width:150,height:150});
 const devices=[{deviceId:'design-device',name:'MacBook Pro'},{deviceId:'phone',id:'phone',name:'iPhone 16',model:'iPhone'},{deviceId:'tablet',id:'tablet',name:'iPad Air',model:'iPad'}];
 for(const d of devices)document.getElementById('deviceList').append(renderDeviceRow(d));
 document.getElementById('contactList').append(renderDeviceRow({deviceId:'friend',name:'小陈的笔记本',model:'Windows 11'},{contact:true}));
 document.querySelector('#nearbyDeviceList .contact-empty').textContent='暂无其他附近设备';
 document.getElementById('connectionHeaderMenuBtn').onclick=()=>{const n=document.getElementById('connectionHeaderMenu');n.hidden=!n.hidden;};
 const records=[
  ['iPhone 16','14:26','<div class="message-bubble">刚把周末拍的照片传上来了，大家可以一起看看。</div>',false],
  ['MacBook Pro','14:27','<div class="message-bubble"><div class="media-preview"><img src="/ui-design/assets/sample-landscape.png" alt="蓝调时刻.png"></div><div class="file-size media-file-size">1.28 MB</div></div>',true],
  ['iPad Air','14:29','<div class="message-bubble file-message"><div class="file-message-main"><div class="file-icon">📄</div><div class="file-info"><div class="file-name">周末拍摄计划.pdf</div><div class="file-size">2.4 MB</div></div></div></div>',false],
  ['MacBook Pro','14:32','<div class="rich-preview"><div class="rich-preview-title"><span>📝</span><span>富文本</span></div><div class="rich-preview-content">下一次出发前，把新的灵感写在这里。</div></div>',true]
 ];
 const messages=document.getElementById('chatMessages');messages.replaceChildren();
 records.forEach(([who,time,body,own])=>{const row=document.createElement('div');row.className='message'+(own?' own':'');row.innerHTML='<div class="message-header"><span>'+who+'</span><span>'+time+'</span></div>'+body+'<div class="message-record-actions"><button class="message-record-menu-trigger" type="button" title="记录操作">☰</button></div>';messages.append(row);});
 document.getElementById('collabStatus').textContent='已同步';
 document.getElementById('editor').innerHTML='<h2>周末的灵感清单</h2><p><br></p><p>一起把还没完成的想法，变成下一次出发的方向。</p><p><br></p><h3>这周一起做</h3><ul><li>整理蓝调时刻的影像素材</li><li>完成网页作品的预览</li><li>选好串流台的周末节目</li></ul><p><br></p><p><strong>拍摄时间：</strong>周六 16:30</p><p><strong>集合地点：</strong>海边咖啡馆</p><p><br></p><blockquote>“留一点空白，给新的灵感。”</blockquote>';
 for(const b of document.querySelectorAll('.mobile-workspace-button'))b.onclick=()=>{document.getElementById('appShell').dataset.mobileView=b.dataset.mobileView;document.querySelectorAll('.mobile-workspace-button').forEach(x=>x.classList.toggle('active',x===b));};
 // Reproduce the existing startup relocation in app.js:initTunnelSettings.
 const tools=document.querySelector('.left-panel .session-tools'),grid=document.getElementById('settingsToolGrid');if(tools&&grid){while(tools.firstChild)grid.append(tools.firstChild);tools.remove();}
}
async function prepare(){
 fillHome();
 const seed=window.DESIGN_SEED,surface=seed.surface;
 if(surface==='route'){
  document.getElementById('appShell').hidden=true;document.getElementById('tunnelTopbar').hidden=true;document.getElementById('sessionLanding').hidden=false;
  document.getElementById('landingSessionPicker').hidden=false;document.getElementById('landingSessionSelect').innerHTML='<option>选择已加入的传输隧道</option><option>灵感工作室 · K7M2P</option><option>周末放映室 · N8Q4T</option>';
  document.getElementById('landingRecentBtn').hidden=false;
  document.querySelectorAll('.tunnel-code-inputs input').forEach((el,i)=>el.value='K7M2P'[i]);
 }
 if(surface==='disk'){DiskClient.setAccount('alice');DiskUI.init({formatFileSize:n=>n>1048576?(n/1048576).toFixed(2)+' MB':(n/1024).toFixed(1)+' KB',showAppToast:()=>{}});await DiskUI.open();await new Promise(resolve=>setTimeout(resolve,650));}
 if(surface==='workshop'){
  WebWorkshop.init({deviceId:()=>state.deviceId,sessionId:()=> 'design-session',toast:()=>{},sourceTunnelLabels:async drafts=>Object.fromEntries(drafts.map(d=>[d.id,'K7M2P · 灵感工作室']))});
  await WebWorkshop.createDraft({name:'周末的灵感手记',files:[{path:'index.html',type:'text/html',data:new TextEncoder().encode(sampleCode)},{path:'assets/',directory:true,data:new Uint8Array()},{path:'assets/style.css',type:'text/css',data:new TextEncoder().encode('body { color: #1e2b3a; background: #fff; }')},{path:'README.md',type:'text/markdown',data:new TextEncoder().encode('# 周末的灵感手记\n\n图片与灵感的私人收藏。')}]});
  await WebWorkshop.createDraft({name:'旅途照片展',files:[{path:'index.html',type:'text/html',data:new TextEncoder().encode(sampleCode)}]});
  WebWorkshop.open();await new Promise(resolve=>setTimeout(resolve,500));
 }
 if(surface==='stream'||surface==='watch'){
  DiskClient.setAccount('alice');localStorage.setItem('streaming:design-device:key',seed.deviceSecret);localStorage.setItem('streaming:design-device:station:'+seed.stationId,JSON.stringify(seed.station));localStorage.setItem('streaming:design-device:ui',JSON.stringify({view:'discover',stationId:'',scroll:{},drafts:{}}));
  StreamingConsole.init({deviceId:()=>state.deviceId,deviceName:()=> 'MacBook Pro',devices:()=>[],tunnels:async()=>[],toast:()=>{},home:()=>{},diskImport:{open:async()=>null}});
  await StreamingConsole.whenReady();await StreamingConsole.open();
  if(surface==='watch'){await new Promise(resolve=>setTimeout(resolve,300));document.querySelector('.sc-row-actions .sc-primary').click();}
  await new Promise(resolve=>setTimeout(resolve,650));
 }
 window.DESIGN_READY=true;
}
prepare().catch(error=>{console.error('DESIGN_BOOT',error);document.body.dataset.designError=error.message;});
