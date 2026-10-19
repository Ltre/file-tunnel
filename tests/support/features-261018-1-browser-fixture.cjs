'use strict';
// Disposable loopback fixture: real entry functions, authorization routes and home CSS.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm'),express=require('express');
const {createTunnelAccess}=require('../../server/tunnel-access');
const root=path.resolve(__dirname,'../..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'dr2t-entry-261018-')),app=express();app.use(express.json());
const source=fs.readFileSync(path.join(root,'app.js'),'utf8'),serverSource=fs.readFileSync(path.join(root,'server.js'),'utf8'),slice=(text,start,end)=>text.slice(text.indexOf(start),text.indexOf(end,text.indexOf(start)));
const sessionId=crypto.randomUUID(),deviceId=crypto.randomUUID(),code='NEW51',tunnelAccess=createTunnelAccess(dataDir);tunnelAccess.issue(sessionId,deviceId);
const infraStore={getTunnel:id=>id===sessionId?{short_code:code}:null,findSessionIdByShortCode:value=>value===code?sessionId:null,findShortCodeForSession:()=>code};
vm.runInNewContext(slice(serverSource,"app.post('/api/tunnel-join-links'",'const io = new Server('),{app,tunnelAccess,infraStore,sessions:new Map(),shortCodes:new Map(),crypto,isValidSessionId:id=>/^[\w-]{8,64}$/.test(id||''),isValidDeviceId:id=>/^[\w-]{8,64}$/.test(id||''),normalizeShortCode:value=>/^[A-Z0-9]{5}$/.test(value||'')?value:''});
app.get('/',(req,res)=>{
    let html=fs.readFileSync(path.join(root,'pages/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
    html=html.replace('</body>','<script src="/entry-fixture.js"></script></body>');res.type('html').send(html);
});
app.get('/entry-fixture.js',(req,res)=>res.type('js').send(`
const state={},sessions=[{sessionId:${JSON.stringify(sessionId)},shortCode:'NEW51',remark:'离线历史设备'}];
if(!localStorage.getItem('deviceId'))localStorage.setItem('deviceId',${JSON.stringify(deviceId)});
localStorage.setItem('fixture-history','本地历史保留');
const getFromStore=async()=>sessions[0],getAllFromStore=async()=>sessions,countFromStore=async()=>0,readSessionDirectoryCache=()=>sessions,replaceSessionDirectoryCache=()=>sessions;
const detectDeviceModel=()=>'',generateId=()=>crypto.randomUUID(),historyLog=()=>{},generateQRCode=()=>{};
${slice(source,'function savedTunnelGrant(','async function leaveTunnel(')}
function closeTunnelCodeScanner(){}
${slice(source,'function applyScannedTunnelCode(','async function openTunnelCodeScanner(')}
document.getElementById('tunnelStartupLoading')?.remove();
const proof=document.createElement('div');proof.id='fixture-proof';proof.style.cssText='position:fixed;top:0;left:0;right:0;padding:12px;background:#eaf2ff;color:#183758;z-index:20000;font-size:14px';document.body.prepend(proof);
(async()=>{
    if(await initSession()&&await ensureTunnelAccess()){
        document.getElementById('sessionLanding').hidden=true;document.getElementById('appShell').hidden=false;document.getElementById('tunnelTopbar')?.removeAttribute('hidden');
        proof.textContent='隔离验证：已进入隧道 · '+state.deviceId.slice(0,8)+' · '+localStorage.getItem('fixture-history');
        document.getElementById('fileUploadComposer').scrollIntoView({block:'center'});
    }else{
        initSessionLanding();proof.textContent='隔离验证：历史设备的本地授权缺失，最新短码为 NEW51';
        const scan=document.createElement('button');scan.textContent='扫描新二维码（隔离验证）';scan.onclick=()=>applyScannedTunnelCode(location.origin+'/?tunnel_join='+${JSON.stringify(tunnelAccess.issueJoin(sessionId,code))}+'#'+${JSON.stringify(sessionId)});document.getElementById('landingNote').after(scan);
    }
})().catch(error=>{proof.textContent=error.message;console.error(error);});
`));
app.use('/client',express.static(path.join(root,'client')));app.use('/prompts/resources/icons',express.static(path.join(root,'prompts/resources/icons')));
const server=app.listen(Number(process.env.TEST_FIXTURE_PORT)||0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/?leave=1',isolatedDataDir:dataDir})));
function close(){server.closeAllConnections();server.close(()=>{const target=path.resolve(dataDir);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('dr2t-entry-261018-'))throw Error('unsafe fixture cleanup');fs.rmSync(target,{recursive:true,force:true});process.exit();});}
process.on('SIGINT',close);process.on('SIGTERM',close);
