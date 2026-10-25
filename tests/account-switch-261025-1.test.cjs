'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const read = name => fs.readFileSync('client/' + name, 'utf8');
const turn = () => new Promise(setImmediate);
test('an uninitialized page finds account tasks across native partitions without opening collaboration resources', async () => {
    const calls = [], window = {};
    const fetch = async (url, options) => {
        calls.push({ url, options }); let data;
        if (url.includes('/spaces')) data = { spaces:[{ scopeKey:'' },{ scopeKey:'space-b' }] };
        else if (url.includes('disk_space=space-b')) data = { operations:[{operation_id:'upload',status:'queued',type:'upload',title:'上传video.mp4'}] };
        else data = { operations:[{operation_id:'copy',status:'running',type:'copy',title:'复制档案'},{operation_id:'finished',status:'completed'}] };
        return {ok:true,json:async()=>data};
    };
    vm.runInNewContext(read('disk-client.js'), {window,fetch,URL,AbortController,setTimeout,clearTimeout,location:{origin:'http://fixture'},setInterval(){},encodeURIComponent});
    const before = window.DiskClient.getAccount();
    const result = await window.DiskClient.accountOperations('alice');
    assert.equal(result.accountId, 'alice'); assert.deepEqual(Array.from(result.operations, item=>item.operation_id).sort(),['copy','upload']);
    assert.equal(window.DiskClient.getAccount(),before); assert.ok(calls.every(call=>call.options.headers['X-Disk-Account']==='alice'));
    assert.equal(calls.some(call=>call.url.includes('collaboration')),false);
    assert.ok(calls.every(call=>!call.options.method || call.options.method==='GET'));
});
test('real drive HTTP operations remain discoverable from a fresh page under their original signed account',async t=>{
    const f=await require('./support/pending-save-261012-fixture.cjs').createFixture(),created=[];t.after(async()=>{for(const [id,account] of created)await call('/api/telegram/drive/operations/'+id,{method:'DELETE',headers:{'X-Disk-Account':account}});await turn();await f.close();});const jar=new Map();
    const call=async(route,options={})=>{
        const response=await fetch(f.base+route,{...options,headers:{Cookie:[...jar].map(([key,value])=>key+'='+value).join('; '),...options.headers}});
        for(const cookie of response.headers.getSetCookie()){const [name,value]=cookie.split(';')[0].split('=');jar.set(name,value);}
        return response;
    };
    const initialize=async id=>{
        await call('/fixture-login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'id='+id});
        const response=await call('/api/telegram/drive/uploads',{method:'POST',headers:{'Content-Type':'application/json','X-Disk-Account':id},body:JSON.stringify({files:[{name:id+'.txt',type:'text/plain',size:3}],folderPath:''})});
        assert.equal(response.ok,true);const operationId=(await response.json()).operation_id;created.push([operationId,id]);return operationId;
    };
    const alice=await initialize('alice'),bob=await initialize('bob'),window={};
    vm.runInNewContext(read('disk-client.js'),{window,fetch:call,URL,AbortController,setTimeout,clearTimeout,location:{origin:f.base},setInterval(){},encodeURIComponent});
    assert.equal(window.DiskClient.getAccount(),'');
    const defaults=await window.DiskClient.accountOperations();assert.equal(defaults.accountId,'bob');assert.ok(defaults.operations.some(job=>job.operation_id===bob));assert.equal(defaults.operations.some(job=>job.operation_id===alice),false);
    const original=await window.DiskClient.accountOperations('alice');assert.ok(original.operations.some(job=>job.operation_id===alice));assert.equal(original.operations.some(job=>job.operation_id===bob),false);
    assert.equal(window.DiskClient.getAccount(),'');
});
test('an unavailable collaboration target does not block checking native account tasks through the real scope router',async t=>{
    const f=await require('./support/pending-save-261012-fixture.cjs').createFixture(),created=[];t.after(async()=>{for(const [id,account] of created)await call('/api/telegram/drive/operations/'+id,{method:'DELETE',headers:{'X-Disk-Account':account}});await turn();await f.close();});const jar=new Map();
    const call=async(route,options={})=>{const response=await fetch(f.base+route,{...options,headers:{Cookie:[...jar].map(([key,value])=>key+'='+value).join('; '),...options.headers}});for(const cookie of response.headers.getSetCookie()){const [name,value]=cookie.split(';')[0].split('=');jar.set(name,value);}return response;};
    const post=async(route,value,account)=>call('/api/telegram/drive'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Disk-Account':account},body:JSON.stringify(value)});
    await call('/fixture-login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'id=alice'});
    const source=f.store.list('alice','甲目录').files[0];
    const invitation=await (await post('/collaborations/invitations',{kind:'file',fileId:source.id},'alice')).json();assert.ok(invitation.collaboration?.id);
    await call('/fixture-login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'id=bob'});
    const token=new URL(invitation.url).pathname.split('/').pop();assert.equal((await post('/collaborations/join',{token},'bob')).ok,true);
    const upload=await (await post('/uploads',{files:[{name:'bob-active.txt',size:3,type:'text/plain'}]},'bob')).json();assert.ok(upload.operation_id);created.push([upload.operation_id,'bob']);
    f.store.remove('alice',source.id);
    const scope='/api/telegram/drive/collaboration-scope/'+invitation.collaboration.id+'/operations';
    const broken=await call(scope,{headers:{'X-Disk-Account':'bob'}});assert.equal((await broken.json()).error,'COLLABORATION_TARGET_NOT_FOUND');
    const window={};vm.runInNewContext(read('disk-client.js'),{window,fetch:call,URL,AbortController,setTimeout,clearTimeout,location:{origin:f.base},setInterval(){},encodeURIComponent});
    const state=await window.DiskClient.accountOperations('bob');assert.ok(state.operations.some(job=>job.operation_id===upload.operation_id));
});
test('readable or editable collaboration tasks owned by another account are not viewer account tasks',async t=>{
    const f=await require('./support/pending-save-261012-fixture.cjs').createFixture(),created=[];t.after(async()=>{for(const [id,account] of created)await call('/api/telegram/drive/operations/'+id,{method:'DELETE',headers:{'X-Disk-Account':account}});await turn();await f.close();});const jar=new Map();
    const call=async(route,options={})=>{const response=await fetch(f.base+route,{...options,headers:{Cookie:[...jar].map(([key,value])=>key+'='+value).join('; '),...options.headers}});for(const cookie of response.headers.getSetCookie()){const [name,value]=cookie.split(';')[0].split('=');jar.set(name,value);}return response;};
    const write=(route,value,account,method='POST')=>call('/api/telegram/drive'+route,{method,headers:{'Content-Type':'application/json','X-Disk-Account':account},body:JSON.stringify(value)});
    await call('/fixture-login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'id=alice'});
    const invitation=await (await write('/collaborations/invitations',{kind:'directory',path:'甲目录'},'alice')).json(),grant=invitation.collaboration.id;
    await call('/fixture-login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'id=bob'});
    assert.equal((await write('/collaborations/join',{token:new URL(invitation.url).pathname.split('/').pop()},'bob')).ok,true);
    const job=await (await write('/collaboration-scope/'+grant+'/uploads',{folderPath:'甲目录',files:[{name:'owner-upload.txt',size:3,type:'text/plain'}]},'alice')).json();assert.ok(job.operation_id);created.push([job.operation_id,'alice']);
    for(const role of ['viewer','editor']){
        assert.equal((await write('/collaborations/'+grant+'/members/bob',{role},'alice','PATCH')).ok,true);
        const visible=await (await call('/api/telegram/drive/collaboration-scope/'+grant+'/operations',{headers:{'X-Disk-Account':'bob'}})).json();assert.ok(visible.operations.some(item=>item.operation_id===job.operation_id&&item.userId==='alice'));
        const window={};vm.runInNewContext(read('disk-client.js'),{window,fetch:call,URL,AbortController,setTimeout,clearTimeout,location:{origin:f.base},setInterval(){},encodeURIComponent});
        const state=await window.DiskClient.accountOperations('bob');assert.equal(state.operations.some(item=>item.operation_id===job.operation_id),false,role);
    }
});
test('an expired current account is reported as unverified instead of silently appearing task-free',async()=>{
    const window={};vm.runInNewContext(read('disk-client.js'),{window,fetch:async()=>({ok:false,status:401,json:async()=>({error:'LOGIN_REQUIRED'})}),URL,AbortController,setTimeout,clearTimeout,location:{origin:'http://fixture'},setInterval(){},encodeURIComponent});
    const state=await window.DiskClient.accountOperations('expired');assert.equal(state.accountId,'expired');assert.equal(state.unverified,true);
});
test('native operation read failures remain explicit instead of being treated as an empty task list',async()=>{
    const window={};vm.runInNewContext(read('disk-client.js'),{window,fetch:async url=>url.includes('/spaces')?{ok:true,json:async()=>({spaces:[{scopeKey:''}]})}:{ok:false,status:503,json:async()=>({error:'OPERATIONS_UNAVAILABLE'})},URL,AbortController,setTimeout,clearTimeout,location:{origin:'http://fixture'},setInterval(){},encodeURIComponent});
    await assert.rejects(window.DiskClient.accountOperations('alice'),/OPERATIONS_UNAVAILABLE/);
});
test('a fresh page also sees another page upload which is still preparing before server registration',async()=>{
    const peers=new Set();class Channel{
        constructor(name){this.name=name;peers.add(this);}
        postMessage(data){for(const peer of peers)if(peer!==this&&peer.name===this.name)queueMicrotask(()=>peer.onmessage?.({data:structuredClone(data)}));}
        close(){peers.delete(this);}
    }
    const create=()=>{const window={};vm.runInNewContext(read('disk-client.js'),{window,BroadcastChannel:Channel,fetch:async url=>({ok:true,json:async()=>url.includes('/spaces')?{spaces:[{scopeKey:''}]}:url.includes('/collaborations')?{collaborations:[]}:{operations:[]}}),URL,AbortController,setTimeout,clearTimeout,location:{origin:'http://fixture'},setInterval(){},encodeURIComponent});return window.DiskClient;};
    const source=create(),fresh=create();let release;
    const uploading=source.upload([{name:'not-yet-sent.txt',size:3,type:'text/plain'}],'',()=>new Promise(resolve=>{release=resolve;}),{transportContext:{accountId:'alice',diskSpace:'',requestBase:'/api/telegram/drive/collaboration-scope/grant'}});
    const state=await fresh.accountOperations('alice');assert.ok(state.operations.some(job=>job.type==='upload'&&job.operation_id.startsWith('local-upload-')&&job.title.includes('not-yet-sent.txt')));
    assert.equal((await fresh.accountOperations('bob')).operations.length,0);
    source.stop();release(new Blob(['abc']));await assert.rejects(uploading,/OPERATION_CANCELLED/);for(const peer of [...peers])peer.close();
});
function switching({ accept = false, operations = [{operation_id:'upload',type:'upload',title:'上传video.mp4',status:'running'}], delayed = false } = {}) {
    let account='alice', resolve; const calls=[], messages=[];
    const window={confirm:message=>{messages.push(message);return accept;},DiskClient:{
        getAccount:()=>account,setAccount:value=>{account=value;},setMount(){},setCollaboration(){},
        accountOperations:async value=>delayed?new Promise(done=>{resolve=()=>done({accountId:value,operations});}):{accountId:value,operations},
        raw:async(route,options)=>{calls.push({route,options});return{};},json:(method,body)=>({method,body:JSON.stringify(body)})
    }};
    const context=vm.createContext({window,telegramDriveNavigationVersion:0,telegramDriveRenderGeneration:0,
        rememberTelegramDriveAccountView(){calls.push({route:'remember'});},cancelTelegramDrivePendingMount(){},closeDiskCollaborationFrame(){},closeDiskPreview(){},clearTelegramDriveSearch(){},clearTelegramDriveSelection(){},
        rememberTelegramDriveActiveAccount(){},renderTelegramDrive:async()=>{},resumeTelegramDriveEntry:async()=>{},telegramDriveMountContext:null,telegramDriveCurrentData:null,telegramDriveStaticLinks:[],telegramDriveSpaceOwner:''});
    const source=read('disk-ui.js');vm.runInContext(source.slice(source.indexOf('async function switchTelegramDriveAccount('),source.indexOf('async function resumeTelegramDriveEntry(')),context);
    return {run:(id,options)=>context.switchTelegramDriveAccount(id,options),calls,messages,account:()=>account,release:()=>resolve()};
}
test('cancelling an active-task account switch preserves identity and performs no account mutation',async()=>{
    const f=switching(); assert.equal(await f.run('bob'),false); assert.equal(f.account(),'alice'); assert.equal(f.calls.length,0);
    assert.match(f.messages[0],/video\.mp4/); assert.match(f.messages[0],/原账号/);
});
test('cancelling after sign-in restores the original default account without removing the new login',async()=>{
    const f=switching(); assert.equal(await f.run('bob',{restoreOnCancel:true}),false); assert.equal(f.account(),'alice');
    assert.equal(f.calls.length,1); assert.equal(f.calls[0].route,'/accounts/select'); assert.equal(JSON.parse(f.calls[0].options.body).accountId,'alice');
});
class Element {
    constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.isConnected=true;this.classList={add(){}};}
    append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
    replaceChildren(...nodes){this.children=[];this.append(...nodes);}
    setAttribute(key,value){this.attrs[key]=value;}
    remove(){this.isConnected=false;if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);}
    querySelectorAll(selector){return this.children.flatMap(node=>[node,...node.querySelectorAll(selector)]).filter(node=>selector==='button'?node.tagName==='button':selector==='[aria-pressed]'?node.attrs['aria-pressed']!==undefined:false);}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}
test('shared account chooser and offline action stay open when the switch was cancelled',async()=>{
    for(const mode of ['choose','normal','offline']){
        const body=new Element('body'),window={addEventListener(){},alert(){throw Error('cancel is not an error');}};
        vm.runInNewContext(read('account-ui.js'),{window,AbortController,setTimeout,clearTimeout,document:{body,createElement:tag=>new Element(tag),addEventListener(){}},location:{href:'http://fixture'},history:{state:{},pushState(value){this.state=value;},replaceState(value){this.state=value;}}});
        const result=window.AccountUI.open({choose:mode==='choose',currentAccount:()=> 'alice',load:async()=>({accounts:[{identity:{id:'bob',name:'Bob'}}],status:{}}),select:async()=>false,offline:async()=>false,renderSignIn(){}});
        await turn();const button=text=>body.querySelectorAll('button').find(node=>node.textContent===text);
        if(mode==='choose'){await button('Bob').onclick();await button('选择此账号').onclick();}
        else await button(mode==='offline'?'使用离线身份':'Bob').onclick();
        assert.equal(window.AccountUI.isOpen(),true,mode);window.AccountUI.close();assert.equal(await result,null);
    }
});
test('sign-in cancellation does not close the account panel or resume a pending save',async()=>{
    const source=read('disk-ui.js'),calls=[],context=vm.createContext({
        telegramDriveLoginTarget:{},telegramDriveOidcPollGeneration:0,telegramDriveOidcPopup:null,telegramDrivePendingSaveRunning:true,telegramDrivePendingSaveId:'pending',
        window:{DiskClient:{raw:async()=>({identity:{id:'bob'}})},AccountUI:{refresh:()=>calls.push('refresh'),completeSignIn:()=>calls.push('close')}},
        switchTelegramDriveAccount:async(_id,options)=>{assert.equal(options.restoreOnCancel,true);return false;},renderTelegramDrive:async()=>calls.push('render'),showAppToast:()=>calls.push('toast'),resumeTelegramDrivePendingSave:async()=>calls.push('resume'),alert:()=>calls.push('alert')
    });
    vm.runInContext(source.slice(source.indexOf('async function finishTelegramDriveOidcLogin('),source.indexOf('async function pollTelegramDriveOidcLogin(')),context);
    assert.equal(await context.finishTelegramDriveOidcLogin('success'),false);assert.deepEqual(calls,['refresh']);
});
test('confirming an account switch retains tasks and switches once; concurrent attempts cannot overwrite it late',async()=>{
    const f=switching({accept:true,delayed:true}); const first=f.run('bob'); await turn();
    assert.equal(await f.run('carol'),false); f.release(); assert.equal(await first,true);
    assert.equal(f.account(),'bob'); assert.equal(f.calls.filter(call=>call.route==='/accounts/select').length,1);
    assert.equal(f.calls.some(call=>call.options?.method==='DELETE'),false);
});
function cookieSwitching({ original='alice', failStage='check', changeDuringCheck='' }={}) {
    let selected=original,defaultAccount='bob';const accounts=new Set(['alice','bob','carol']),calls=[];
    const window={DiskClient:{getAccount:()=>selected,setAccount:id=>{selected=id;},setMount(){},setCollaboration(){},
        accountOperations:async()=>{if(changeDuringCheck){selected=changeDuringCheck;defaultAccount=changeDuringCheck;}if(failStage==='check')throw Error('NETWORK_ERROR');return{accountId:original,operations:[]};},
        raw:async(route,options)=>{calls.push({route,options});if(route==='/accounts/select'){const id=JSON.parse(options.body).accountId;if(id&&!accounts.has(id))throw Error('LOGIN_REQUIRED');defaultAccount=id;}return{};},json:(method,body)=>({method,body:JSON.stringify(body)})}};
    const context=vm.createContext({window,telegramDriveNavigationVersion:0,telegramDriveRenderGeneration:0,telegramDriveMountContext:null,telegramDriveCurrentData:null,telegramDriveStaticLinks:[],telegramDriveSpaceOwner:'',
        rememberTelegramDriveAccountView(){},cancelTelegramDrivePendingMount(){},closeDiskCollaborationFrame(){},closeDiskPreview(){},clearTelegramDriveSearch(){},clearTelegramDriveSelection(){},rememberTelegramDriveActiveAccount(){},
        renderTelegramDrive:async()=>{if(failStage==='render')throw Error('RENDER_FAILED');},resumeTelegramDriveEntry:async()=>{},historyLog(){}});
    const source=read('disk-ui.js');vm.runInContext(source.slice(source.indexOf('async function switchTelegramDriveAccount('),source.indexOf('async function resumeTelegramDriveEntry(')),context);
    return {run:()=>context.switchTelegramDriveAccount('bob',{restoreOnCancel:true}),selected:()=>selected,defaultAccount:()=>defaultAccount,accounts,calls};
}
test('a login switch failure before local commit restores the old cookie selection including offline identity',async()=>{
    for(const original of ['alice','']){
        const f=cookieSwitching({original});await assert.rejects(f.run(),/NETWORK_ERROR/);
        assert.equal(f.selected(),original);assert.equal(f.defaultAccount(),original);assert.ok(f.accounts.has('bob'),'the newly authenticated account must remain signed in');
        assert.equal(f.calls.length,1);assert.equal(JSON.parse(f.calls[0].options.body).accountId,original);
    }
});
test('a render failure after local commit keeps the new cookie selection and never rolls back the switched account',async()=>{
    const f=cookieSwitching({failStage:'render'});await assert.rejects(f.run(),/RENDER_FAILED/);assert.equal(f.selected(),'bob');assert.equal(f.defaultAccount(),'bob');assert.equal(f.calls.length,1);
});
test('a stale login switch never restores its old selection over an externally changed account',async()=>{
    const f=cookieSwitching({changeDuringCheck:'carol'});await assert.rejects(f.run(),/NETWORK_ERROR/);assert.equal(f.selected(),'carol');assert.equal(f.defaultAccount(),'carol');assert.equal(f.calls.length,0);
});
test('an identity-changed early cancellation preserves the newer default selection without restoration',async()=>{
    const f=cookieSwitching({failStage:'none',changeDuringCheck:'carol'});assert.equal(await f.run(),false);assert.equal(f.selected(),'carol');assert.equal(f.defaultAccount(),'carol');assert.equal(f.calls.length,0);
});
