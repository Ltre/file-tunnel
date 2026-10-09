'use strict';
// Real isolated SQLite/API, synthetic zero-byte import resources; never contacts Telegram.
const fs=require('node:fs'),path=require('node:path');
const {createFixture}=require('./disk-content-admin-fixture.cjs');
async function createUiFixture(){
    const f=await createFixture(),app=f.server.listeners('request')[0],root=path.join(__dirname,'../..'),drive=f.api.spaces.get('');
    drive.createDirectory('alice','资料/同名/下层',20);drive.createDirectory('alice','导入资源',20);
    drive.putMetadataObject({id:'alice'},'导入资源','中文样式.css','text/css',{},20);
    app.get('/fixture-ui',(_req,res)=>{
        let html=fs.readFileSync(path.join(root,'pages/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
        html=html.replace('</body>','<div style="position:fixed;top:0;z-index:10"><button id="fixtureWorkshop">验收网页工坊</button><span id="fixtureStatus"></span></div>'+['disk-error-messages','disk-client','disk-directory-picker','disk-mount-ui','disk-trash-ui','disk-import-picker','disk-ui','folder-archive','web-workshop'].map(name=>`<script src="/client/${name}.js"></script>`).join('')+'<script src="/fixture-ui-setup.js"></script></body>');
        res.type('html').send(html);
    });
    app.get('/fixture-ui-setup.js',(_req,res)=>res.type('js').send(`document.getElementById('tunnelStartupLoading')?.remove();window.prompt=(_m,value)=>value;window.DiskUI.init({formatFileSize:n=>n+' B',showAppToast:m=>{document.getElementById('fixtureStatus').textContent=m;}});window.WebWorkshop.init({deviceId:()=> 'fixture',toast:m=>{document.getElementById('fixtureStatus').textContent=m;}});document.getElementById('fixtureWorkshop').onclick=async()=>{await window.WebWorkshop.createDraft({name:'导入验收',files:[{path:'index.html',type:'text/html',data:new TextEncoder().encode('<p>原有正文保留</p>')}]});window.WebWorkshop.open();};window.DiskUI.open();`));
    return f;
}
module.exports={createUiFixture};
if(require.main===module)createUiFixture().then(f=>{console.log(f.base+'/fixture-ui');process.once('SIGINT',()=>f.close().then(()=>process.exit()));});
