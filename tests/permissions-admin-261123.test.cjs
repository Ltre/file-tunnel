'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {createAdminDbscSessions}=require('../server/admin-dbsc-sessions');
test('管理员会话按实际已验证请求保存各 IP 最后活动时间，拒绝的请求不写入',t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admin-ip-261123-'));
    t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('admin-ip-261123-'));fs.rmSync(dir,{recursive:true,force:true});});
    const auth=createAdminDbscSessions({dataDir:dir,signingKey:()=> 'fixture-only-signing-key',marker:()=> 'fixture-marker'});
    const now=Date.now(),session={id:crypto.randomBytes(32).toString('base64url'),marker:'fixture-marker',boundAt:now,createdAt:now,lastActivityAt:now-100000,expiresAt:now+86400000,address:'10.0.0.1',ipActivity:[{address:'10.0.0.1',lastActivityAt:now-100000}]};
    fs.writeFileSync(path.join(dir,'.admin-dbsc-sessions.json'),JSON.stringify([session]));
    const cookie=auth.COOKIE_NAME+'='+auth._test.grant(session);
    const req=ip=>({ip,headers:{cookie},get(name){return this.headers[name.toLowerCase()]||'';}});
    assert.ok(auth.verify(req('10.0.0.2'),true));const first=auth.list()[0];assert.equal(first.ipActivity.length,2);assert.equal(first.ipActivity[0].lastActivityAt,now-100000);
    assert.ok(auth.verify(req('10.0.0.1'),true));const second=auth.list()[0];assert.equal(second.ipActivity.length,2);assert.ok(second.ipActivity[0].lastActivityAt>=now);assert.equal(second.ipActivity[1].lastActivityAt,first.ipActivity[1].lastActivityAt);
    assert.equal(auth.verify({ip:'203.0.113.9',headers:{cookie:cookie+'invalid'}},true),null);assert.equal(auth.list()[0].ipActivity.length,2);
    auth.revoke(session.id);assert.equal(auth.verify(req('10.0.0.3'),true),null);assert.equal(auth.list()[0].ipActivity.length,2);
});

test('既有网页记录的菜单在打开时读取最新权限，无需重新渲染记录或预先拥有他人的文件编辑授权',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),start=source.indexOf('function renderMessageRecordActions('),end=source.indexOf('const selectedHistoryIds',start);
    let visible=[];const elements=[];
    const element=()=>({dataset:{},querySelector:()=>null,toggleAttribute(){},setAttribute(){},addEventListener(name,run){this[name]=run;},appendChild(){}});
    const context=vm.createContext({webZipPublishAllowed:false,window:{},document:{createElement:()=>{const value=element();elements.push(value);return value;}},
        createRecordActionButton:(icon,label)=>({dataset:{},label}),markSelectedHistoryRow(){},openMessageRecordActionMenu:(_trigger,items)=>{visible=items.map(item=>item.label);}});
    vm.runInContext(source.slice(start,end),context);
    context.renderMessageRecordActions(element(),{id:'forwarded-webpage',type:'file',fileInfo:{id:'file',name:'别人的网页.html.zip',creatorDeviceId:'someone-else'}});
    const trigger=elements.at(-1),event={preventDefault(){},stopPropagation(){}};
    trigger.click(event);assert.equal(visible.includes('编辑此网页'),false);
    context.webZipPublishAllowed=true;trigger.click(event);assert.equal(visible.includes('编辑此网页'),true);
    context.webZipPublishAllowed=false;trigger['record-menu-open']({detail:{}});assert.equal(visible.includes('编辑此网页'),false);
});
test('网页功能权限刷新绑定焦点账号，迟到响应不能覆盖新账号，Socket 未就绪不再隐藏合法编辑入口',async()=>{
    const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),start=source.indexOf('let webZipPublishAllowed='),end=source.indexOf('async function signWebZipArchive(',start);
    const requests=[],tiles=[{hidden:true}],buttons={webWorkshopBtn:{hidden:true},topbarWorkshopBtn:{hidden:true}};let account='alice';
    const context=vm.createContext({state:{sessionId:'A',socket:null},window:{DiskClient:{getAccount:()=>account}},document:{getElementById:id=>buttons[id],querySelectorAll:()=>tiles,querySelector:()=>null},fetch:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve})),savedTunnelGrant:()=> 'fixture'});
    vm.runInContext(source.slice(start,end),context);
    const original=vm.runInContext('refreshWebZipAccess()',context);assert.equal(requests[0].options.headers['X-Disk-Account'],'alice');
    account='bob';const changed=vm.runInContext('refreshWebZipAccess()',context);requests[1].resolve({ok:true,json:async()=>({allowed:false})});await changed;
    requests[0].resolve({ok:true,json:async()=>({allowed:true})});await original;assert.equal(vm.runInContext('webZipPublishAllowed',context),false);assert.equal(tiles[0].hidden,true);
    account='alice';const allowed=vm.runInContext('refreshWebZipAccess()',context);requests[2].resolve({ok:true,json:async()=>({allowed:true})});await allowed;
    assert.equal(tiles[0].hidden,false);assert.equal(buttons.webWorkshopBtn.hidden,false);assert.equal(buttons.topbarWorkshopBtn.hidden,false);
});

test('网页 ZIP 异步摘要期间切换账号，不借用新账号的 Socket 证明签章',async()=>{
    const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),start=source.indexOf('async function signWebZipArchive('),end=source.indexOf('async function sendFile(',start);let account='alice',resolveDigest,emitted=0;
    const socket={connected:true,timeout:()=>({emit(){emitted++;}})},context=vm.createContext({window:{DiskClient:{getAccount:()=>account},WebZipRuntime:{digestArchive:()=>new Promise(resolve=>resolveDigest=resolve)}},state:{sessionId:'A',socket},requireWebZipSocketAuth:async()=>({sessionId:'A',accountId:account,socket})});
    vm.runInContext(source.slice(start,end),context);const signing=context.signWebZipArchive({arrayBuffer:async()=>new ArrayBuffer(0)},{id:'fixture-file'},'fixture-record');
    await new Promise(setImmediate);account='bob';resolveDigest('0'.repeat(64));await assert.rejects(signing,/账号操作未完成/);assert.equal(emitted,0);
});
