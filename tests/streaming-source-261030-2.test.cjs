'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../client/disk-ui.js'),'utf8');
function setup({account='alice',switchAllowed=true,logged=true,delay=false}={}){
 let selected=account,release;const calls=[],highlights=[];
 const c={window:{DiskClient:{getAccount:()=>selected,getSpace:()=>'',setMount(){},setCollaboration(){},setSpace(){},hasActiveOperations:()=>false,
 raw:async(url,ctx)=>{calls.push({url,ctx});if(url==='/accounts')return {accounts:logged?[{identity:{id:'alice'}}]:[]};if(url==='/spaces')return {spaces:[{scopeKey:'',state:'ACTIVE'}]};if(delay)await new Promise(resolve=>release=resolve);return {file:{id:'f',folderPath:'current-folder'}};}}},
 manageTelegramDriveAccounts:async()=>null,switchTelegramDriveAccount:async id=>{if(!switchAllowed)return false;selected=id;c.bump();return true;},telegramDriveSpaceKey:s=>s.scopeKey,cancelTelegramDrivePendingMount(){},closeDiskCollaborationFrame(){},closeDiskPreview(){},openTelegramDrive:async()=>calls.push({open:true}),navigateTelegramDrive:async p=>{c.bump();calls.push({path:p});},highlightTelegramDriveRow:item=>highlights.push(item),telegramDriveMountContext:null};
 vm.createContext(c);vm.runInContext('let telegramDriveNavigationVersion=0,telegramDriveCurrentData=null,telegramDriveContentStale=false;function bump(){telegramDriveNavigationVersion++;}\n'+source.slice(source.indexOf('let telegramDriveSourceLocation ='),source.indexOf('function appendTelegramDriveAddAccount(')),c);
 return {c,calls,highlights,setAccount:id=>selected=id,release:()=>release()};
}
const target={accountId:'alice',diskSpace:'',fileId:'f'};
test('drive source navigation reads current folder in its native account scope and highlights exactly the file',async()=>{
 const f=setup({account:'bob'});assert.equal(await f.c.revealTelegramDriveSourceFile(target),true);assert.equal(f.calls.find(x=>x.path).path,'current-folder');assert.equal(f.highlights[0].id,'f');
 const request=f.calls.find(x=>x.url==='/files/f');assert.equal(request.ctx.accountId,'alice');assert.equal(request.ctx.requestBase,'/api/telegram/drive');
});
test('cancelled account switch or missing target login never opens the drive or fetches the file',async()=>{
 for(const options of [{account:'bob',switchAllowed:false},{logged:false}]){const f=setup(options);assert.equal(await f.c.revealTelegramDriveSourceFile(target),false);assert.equal(f.calls.some(x=>x.open||x.url==='/files/f'),false);}
});
test('late file lookup does not replace a newer user navigation or account',async()=>{
 for(const change of ['navigation','account']){const f=setup({delay:true}),pending=f.c.revealTelegramDriveSourceFile(target);await new Promise(setImmediate);if(change==='navigation')f.c.bump();else f.setAccount('bob');f.release();assert.equal(await pending,false);assert.equal(f.highlights.length,0);assert.equal(f.calls.some(x=>x.open),false);}
});
