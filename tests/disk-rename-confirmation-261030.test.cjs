'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../client/disk-ui.js'),'utf8');
function fixture({exposed=true,name='新名字.txt',mounted=false,confirm,preflightError}={}){
    let current={accountId:'alice',diskSpace:'space-a',requestBase:'/api/telegram/drive'+(mounted?'/mount-scope/mount-a':'')};
    const preflights=[],writes=[],refreshes=[],toasts=[];
    const element=()=>({children:[],append(...nodes){this.children.push(...nodes);}});
    const context=vm.createContext({window:{DiskClient:{context:()=>({...current}),raw:async(url,options)=>{
        preflights.push({url,options,body:JSON.parse(options.body)});if(preflightError)throw new Error(preflightError);return {requiresConfirmation:exposed};
    }}},document:{createElement:element,createTextNode:text=>({textContent:text})},
        promptTelegramDriveText:async()=>name,
        openTelegramDriveDialog:async dialog=>confirm?confirm(dialog):false,
        telegramDriveRequest:async(url,options)=>{writes.push({url,options,body:JSON.parse(options.body)});},
        renderTelegramDrive:async()=>{refreshes.push(true);},showAppToast:message=>toasts.push(message)
    });
    vm.runInContext(source.slice(source.indexOf('async function renameTelegramDriveItem('),source.indexOf('async function chooseTelegramDriveDestination('))+';this.rename=renameTelegramDriveItem;',context);
    return {rename:context.rename,preflights,writes,refreshes,toasts,switchAccount:()=>{current={...current,accountId:'bob'};}};
}
const file={kind:'file',id:'file-a',name:'原文件.txt'};

test('declining rename impact confirmation does not mutate or announce success',async()=>{
    let asked=false;
    const f=fixture({confirm:dialog=>{
        asked=true;assert.equal(dialog.title,'确认重命名开放范围内的内容');assert.equal(dialog.confirmText,'坚持重命名');
        assert.match(dialog.body.children[0].textContent,/相关使用者或公开链接可能无法正常读取重命名后的内容/);
        assert.equal(dialog.body.children[1].className,'disk-exposure-acknowledgement');assert.throws(()=>dialog.validate(),/请先勾选/);return false;
    }});
    await f.rename(file);assert.equal(asked,true);assert.equal(f.preflights.length,1);assert.equal(f.writes.length,0);assert.equal(f.refreshes.length,0);assert.equal(f.toasts.length,0);
});

test('rename confirmation is included in the first mutation and retains its original account',async()=>{
    const f=fixture({confirm:dialog=>{
        assert.equal(f.writes.length,0,'confirmation must precede the first mutation');
        dialog.body.children[1].children[0].checked=true;assert.equal(dialog.validate(),true);f.switchAccount();return true;
    }});
    await f.rename(file);assert.equal(f.writes.length,1);assert.equal(f.writes[0].body.confirm_exposed_rename,true);
    assert.equal(f.writes[0].options.accountId,'alice');assert.equal(f.writes[0].options.diskSpace,'space-a');assert.equal(f.refreshes.length,0);assert.deepEqual(f.toasts,['已重命名']);
});

test('unexposed files and existing mounted scopes retain their normal rename routes',async()=>{
    for(const mounted of [false,true]){
        const f=fixture({exposed:false,mounted});await f.rename({kind:'directory',path:'父目录/原目录',name:'原目录'});
        assert.equal(f.preflights.length,mounted?0:1);assert.equal(f.writes.length,1);assert.equal(f.writes[0].url,'/api/telegram/drive/directories');
        assert.equal(f.writes[0].body.path,'父目录/原目录');assert.equal(f.writes[0].body.confirm_exposed_rename,false);assert.equal(f.refreshes.length,1);
    }
});

test('cancelled names and failed preflight do not submit a rename',async()=>{
    for(const name of [null,'原文件.txt']){const f=fixture({name});await f.rename(file);assert.equal(f.preflights.length,0);assert.equal(f.writes.length,0);}
    const f=fixture({preflightError:'NETWORK_ERROR'});await assert.rejects(f.rename(file),/NETWORK_ERROR/);assert.equal(f.writes.length,0);assert.equal(f.toasts.length,0);
});
