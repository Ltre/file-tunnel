'use strict';
// Isolated UI regression page: synthetic in-memory API only, no Telegram/disk data.
// node tests/support/features-261009-fixture.cjs -> http://127.0.0.1:3189
const express = require('express'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..'), app = express();
let spaces = [{id:'default',scopeKey:'',name:'默认分区',isDefault:true,state:'ACTIVE'}, {id:'media',scopeKey:'media',name:'媒体分区',state:'ACTIVE'}];
let collaborations = [
    {id:'own',owned:true,kind:'directory',name:'资料',path:'资料',diskSpace:''},
    {id:'guest',owned:false,role:'editor',kind:'directory',name:'受邀项目名称很长用于检查自动换行以及整行宽度一致',path:'远端根',diskSpace:'foreign'},
    {id:'guest-file',owned:false,role:'editor',kind:'file',name:'单个文件项目',fileId:'foreign-file',path:'',diskSpace:'foreign'}
];
let mounts = [{id:'mount',mountId:'mount',kind:'collaboration_mount',collaborationId:'guest',diskSpace:'',parentPath:'',name:'协同挂载名称很长应完整显示且图标和普通项目对齐',lastKnownTitle:'来源名称非常非常非常非常非常长也必须完整显示',status:'active'}];
const setup = `
document.getElementById('tunnelStartupLoading')?.remove();
// The in-app browser does not support native prompt; accept its default only in this fixture.
window.prompt=(_message,value)=>value;
window.DiskUI.init({formatFileSize:n=>n+' B',showAppToast:msg=>{document.getElementById('fixtureStatus').textContent=msg;}});
window.WebWorkshop.init({deviceId:()=> 'fixture',toast:msg=>{document.getElementById('fixtureStatus').textContent=msg;}});
document.getElementById('fixtureOpen').onclick=()=>window.DiskUI.open();
document.getElementById('fixtureWorkshop').onclick=async()=>{await window.WebWorkshop.createDraft({name:'原网页',sourceFileId:'source-file',sourceMessageId:'source-record',sourceFileInfo:{id:'source-file'},publishMode:'update',files:[{path:'index.html',type:'text/html',data:new TextEncoder().encode('<p>初始正文</p>')}]});window.WebWorkshop.open();};
window.DiskUI.open();
`;
app.use(express.json());
app.get('/', (req,res) => {
    let html = fs.readFileSync(path.join(root, 'pages/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
    html = html.replace('</body>', '<div style="position:fixed;z-index:3000;top:10px"><button id="fixtureOpen">打开模拟网盘</button><button id="fixtureWorkshop">打开模拟工坊</button><span id="fixtureStatus"></span></div>' +
        ['/client/disk-client.js','/client/disk-directory-picker.js','/client/disk-mount-ui.js','/client/disk-ui.js','/client/folder-archive.js','/client/web-workshop.js','/setup.js'].map(src=>`<script src="${src}"></script>`).join('')+'</body>');
    res.type('html').send(html);
});
app.get('/setup.js', (req,res)=>res.type('js').send(setup));
app.get('/api/telegram/drive/me', (req,res)=>res.json({identity:{id:'fixture',name:'模拟网盘用户'},enabled:true,configured:true,oidcMode:'mock'}));
app.get('/api/telegram/drive/spaces', (req,res)=>res.json({spaces}));
app.post('/api/telegram/drive/spaces', (req,res)=>{const space={id:'new',scopeKey:'new',name:req.body.name,state:'ACTIVE'};spaces.push(space);res.json({partition:space});});
app.patch('/api/telegram/drive/spaces/:id', (req,res)=>{const partition=spaces.find(s=>s.id===req.params.id);partition.name=req.body.name;res.json({partition});});
app.get('/api/telegram/drive/spaces/s3', (req,res)=>res.json({enabled:false}));
app.get('/api/telegram/drive/operations', (req,res)=>res.json({operations:[]}));
app.get('/api/telegram/drive/collaborations', (req,res)=>res.json({collaborations}));
app.delete('/api/telegram/drive/collaborations/:id', (req,res)=>{collaborations=collaborations.filter(c=>c.id!==req.params.id);res.json({ok:true});});
app.post('/api/telegram/drive/collaborations/:id/leave', (req,res)=>{collaborations=collaborations.filter(c=>c.id!==req.params.id);res.json({ok:true});});
app.get('/api/telegram/drive/static-resources', (req,res)=>res.json({links:[{id:'static',token:'test',directories:['资料'],files:[],cacheMaxAge:86400}]}));
app.get('/api/telegram/drive/directories', (req,res)=>res.json({directories:[{path:'资料',name:'资料',parentPath:''},{path:'资料/子目录',name:'子目录',parentPath:'资料'}]}));
app.post('/api/telegram/drive/mounts', (req,res)=>{const mount={id:'created',mountId:'created',kind:'collaboration_mount',collaborationId:req.body.collaborationId,status:'active',diskSpace:req.query.disk_space||'',parentPath:req.body.parentPath,name:req.body.name};mounts.push(mount);res.json({mount});});
app.get('/api/telegram/drive/mounts/:id/resolve', (req,res)=>res.json({mount:mounts.find(m=>m.id===req.params.id)}));
app.get('/disk-collab/view/:id', (req,res)=>res.type('html').send('<h1>模拟协同页</h1><p>仅测试浮层打开和返回；无真实业务操作。</p>'));
const files = folderPath => Array.from({length:10},(_,i)=>({id:'file-'+i,kind:'file',name:'普通文件-'+i+'-用于检查网格文件名完整显示和行高不会被压缩遮挡.txt',size:2048,type:'text/plain',folderPath,updatedAt:Date.now()}));
app.get('/api/telegram/drive/list', (req,res)=>{const folderPath=req.query.path||'',space=req.query.disk_space||'';res.json({user_id:'fixture',path:folderPath,files:files(folderPath),folders:folderPath?[]:[{kind:'directory',name:'资料',path:'资料',parentPath:'',fileCount:10,collaborationId:'own'}],mounts:mounts.filter(m=>m.diskSpace===space&&m.parentPath===folderPath),breadcrumbs:folderPath?[{name:folderPath,path:folderPath}]:[],summary:{folderCount:folderPath?0:1,fileCount:10}});});
app.get('/api/telegram/drive/search', (req,res)=>res.json({files:files(''),folders:[],mounted:[{id:'foreign-file',kind:'mounted_file',origin:'collaboration',mountId:'mount',collaborationId:'guest',folderPath:'远端根',name:'受邀搜索资源完整名称以及中文不会被截断.txt',type:'text/plain',size:100,mountName:mounts[0].name,sourceTitle:'来自他人的协同项目名称很长很长很长'}]}));
app.use('/client', express.static(path.join(root,'client')));
app.listen(3189,'127.0.0.1',()=>console.log('Isolated fixture: http://127.0.0.1:3189'));
