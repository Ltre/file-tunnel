'use strict';
// Isolated UI fixture: real preview/menu code, synthetic records and local SVG.
const express=require('express'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),app=express(),source=fs.readFileSync(path.join(root,'app.js'),'utf8');
const slice=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const functions=[slice('function createFileActionButton(','function syncFileMessageExternalSourceBadge('),slice('function recordTextPayload(','async function toggleTransferRecordFavorite('),slice('function openMessageRecordActionMenu(','async function editTransferRecordRemark('),slice('async function copyTextToClipboard(','async function shareFileMagnet(')].join('\n');
const image='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#ddeaff"/><text x="100" y="190" font-size="32">261017-3 preview</text></svg>';
app.get('/',(req,res)=>{
    let html=fs.readFileSync(path.join(root,'pages/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
    html=html.replace('</body>',`<section style="position:fixed;inset:0;background:#f6f8fc;padding:30px;overflow:auto;z-index:10"><h2>261017-3 隔离交互检查</h2><button id="fixture-open">打开网盘</button><div id="fixture-records"></div><p id="fixture-status" role="status"></p></section><script src="/client/disk-operation-order.js"></script><script src="/client/disk-client.js"></script><script src="/client/disk-ui.js"></script><script src="/fixture.js"></script></body>`);
    res.type('html').send(html);
});
app.get('/fixture.js',(req,res)=>res.type('js').send(`
const messages=[{id:'plain',type:'text',text:'第一行\\n第二行'},{id:'rich',type:'rich',content:'<p><strong>粗体标题</strong></p><p>第二段 <a href="https://example.com">链接</a></p>'},{id:'file',type:'file',remark:'这是文件备注',fileInfo:{name:'测试文件.txt'}}];
async function getFromStore(_store,id){return messages.find(m=>m.id===id)}
function getRichMessageContent(message){return message.content||''}
function showAppToast(text){document.getElementById('fixture-status').textContent=text}
${functions}
document.getElementById('tunnelStartupLoading')?.remove();window.DiskUI.init();document.getElementById('fixture-open').onclick=()=>window.DiskUI.open();
const inspect=document.createElement('button');inspect.textContent='检查刚复制的剪贴板';inspect.onclick=async()=>{try{const items=await navigator.clipboard.read(),rows=[];for(const item of items)for(const type of item.types)if(type.startsWith('text/'))rows.push(type+': '+await(await item.getType(type)).text());document.getElementById('fixture-status').textContent=rows.join(' | ')||'剪贴板为空'}catch(error){showAppToast(error.message)}};document.querySelector('#fixture-status').before(inspect);
for(const message of messages){const row=document.createElement('article');row.className='message';row.dataset.fixtureId=message.id;row.style.cssText='position:relative;margin:20px 0;padding:20px;background:white;min-height:80px;max-width:500px';const text=document.createElement('div');text.textContent=message.text||message.remark||'富文本：粗体标题 / 第二段链接';row.append(text);document.getElementById('fixture-records').append(row);renderMessageRecordActions(row,message)}
`));
app.get('/api/telegram/drive/me',(req,res)=>res.json({identity:{id:'fixture',name:'本地交互检查'},enabled:true,configured:true}));
app.get('/api/telegram/drive/spaces',(req,res)=>res.json({spaces:[{id:'default',scopeKey:'',displayName:'测试分区',state:'ACTIVE'}]}));
app.get('/api/telegram/drive/accounts',(req,res)=>res.json({accounts:[]}));
for(const name of ['magnifier-plus.svg','magnifier-minus.svg'])app.get('/prompts/resources/'+name,(req,res)=>res.sendFile(path.join(root,'prompts/resources',name)));
app.get('/api/telegram/drive/list',(req,res)=>{
    const current=String(req.query.path||''),parts=current.split('/').filter(Boolean);
    res.json({path:current,breadcrumbs:parts.map((name,index)=>({name,path:parts.slice(0,index+1).join('/')})),summary:{folderCount:1,fileCount:1},folders:[{kind:'directory',name:'下一层',path:[current,'下一层'].filter(Boolean).join('/')}],files:[{id:'fixture-image',kind:'file',name:'测试图片.svg',path:current,type:'image/svg+xml',size:Buffer.byteLength(image)}]});
});
for(const suffix of ['', '/stream'])app.get('/api/telegram/drive/files/fixture-image'+suffix,(req,res)=>res.type('svg').send(image));
app.get('/api/telegram/drive/operations',(req,res)=>res.json({operations:[]}));
app.use('/client',express.static(path.join(root,'client')));
const server=app.listen(3189,'127.0.0.1',()=>console.log('261017-3 UI fixture: http://127.0.0.1:3189/'));
const close=()=>{server.closeAllConnections();server.close(()=>process.exit())};process.on('SIGINT',close);process.on('SIGTERM',close);
