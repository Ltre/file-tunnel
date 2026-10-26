// Populate the real, fully initialized front page with isolated design samples.
(async()=>{
 await startTunnelApplication({joined:false});
 state.sessionId='design-session-001';state.shortCode='K7M2P';state.sessionRemark='灵感工作室';state.deviceName='MacBook Pro';state.sessionOwnerDeviceId=state.deviceId;
 state.devices=new Map([['design-phone',{id:'design-phone',deviceId:'design-phone',name:'iPhone 16',deviceName:'iPhone 16',model:'iPhone'}],['design-tablet',{id:'design-tablet',deviceId:'design-tablet',name:'iPad Air',deviceName:'iPad Air',model:'iPad'}]]);
 state.dataChannels=new Map([['design-phone',{readyState:'open'}],['design-tablet',{readyState:'open'}]]);
 state.contacts=new Map([['design-friend',{deviceId:'design-friend',name:'小陈的笔记本',model:'Windows 11'}]]);
 await saveToStore('sessions',{sessionId:state.sessionId,shortCode:state.shortCode,remark:state.sessionRemark,createdAt:Date.now()});
 await saveToStore('sessions',{sessionId:'design-session-002',shortCode:'N8Q4T',remark:'周末放映室',createdAt:Date.now()});
 document.getElementById('leaveTunnelBtn').hidden=false;for(const id of ['leaveTunnelPanelBtn','exitTunnelBtn'])document.getElementById(id).hidden=false;
 for(const [id,value] of Object.entries({sessionId:state.sessionId,deviceId:state.deviceId.slice(0,12)+'…',sessionRemark:state.sessionRemark,shortCode:state.shortCode}))document.getElementById(id).textContent=value;
 document.getElementById('sessionRemarkRow').hidden=false;updateDeviceList();
 const q=document.getElementById('qrcode');q.replaceChildren();new QRCode(q,{text:'https://example.invalid/?code=K7M2P',width:150,height:150});
 const picture=await(await fetch('/ui-design/assets/sample-landscape.png')).arrayBuffer();
 const photo={id:'design-photo',name:'蓝调时刻.png',type:'image/png',size:picture.byteLength,data:picture,sessionId:state.sessionId,ownerDeviceId:state.deviceId,isSmall:true,timestamp:Date.now()-120000};
 await saveToStore('files',photo);
 const ghost={id:'design-orphan',name:'周末拍摄花絮-未完成缓存.mp4',type:'video/mp4',size:1121976,data:new Uint8Array(128).buffer,sessionId:state.sessionId,ownerDeviceId:state.deviceId,timestamp:Date.now()};
 await saveToStore('files',ghost);
 const records=[
 {id:'design-msg-text',type:'text',text:'刚把周末拍的照片传上来了，大家可以一起看看。',sender:'design-phone',senderName:'iPhone 16'},
 {id:'design-msg-photo',type:'file',fileInfo:{...photo,data:undefined},sender:state.deviceId,senderName:'MacBook Pro'},
 {id:'design-msg-rich',type:'rich',content:'<h2>下一次出发</h2><p>整理蓝调时刻的照片、声音和一些还没完成的想法。</p><ul><li>海边咖啡馆集合</li><li>周六 16:30</li></ul>',sender:'design-tablet',senderName:'iPad Air'},
 {id:'design-msg-markdown',type:'markdown',markdown:'# 周末的灵感清单\n\n一起把还没完成的想法，变成下一次出发的方向。\n\n- 整理影像素材\n- 完成网页作品预览',sender:state.deviceId,senderName:'MacBook Pro'},
 {id:'design-msg-collection',type:'collection',collection:{id:'design-album',files:[{...photo,data:undefined},{...photo,id:'design-photo-copy',name:'山间的风.png',data:undefined}],remark:'#周末 #灵感'},sender:'design-phone',senderName:'iPhone 16'}
 ];
 document.getElementById('chatMessages').replaceChildren();
 for(const [i,record]of records.entries()){record.sessionId=state.sessionId;record.timestamp=Date.now()-300000+i*45000;await saveToStore('messages',record);await addMessageToChat(record,record.sender===state.deviceId,{autoRequestAsset:false,scroll:false});}
 document.getElementById('editor').innerHTML='<h2>周末的灵感清单</h2><p><br></p><p>一起把还没完成的想法，变成下一次出发的方向。</p><p><br></p><h3>这周一起做</h3><ul><li>整理蓝调时刻的影像素材</li><li>完成网页作品的预览</li><li>选好串流台的周末节目</li></ul><p><br></p><p><strong>拍摄时间：</strong>周六 16:30</p><p><strong>集合地点：</strong>海边咖啡馆</p><p><br></p><blockquote>留一点空白，给新的灵感。</blockquote>';
 document.getElementById('collabStatus').textContent='已同步';
 document.getElementById('chatMessages').scrollTop=0;
 window.DESIGN_HOME_READY=true;
})().catch(e=>{window.DESIGN_HOME_ERROR=e.message;console.error('DESIGN_HOME',e);});
