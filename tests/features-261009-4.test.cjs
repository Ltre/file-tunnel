'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createFixture}=require('./support/disk-content-admin-fixture.cjs');
const ui=fs.readFileSync('client/disk-ui.js','utf8');
const section=(start,end)=>ui.slice(ui.indexOf(start),ui.indexOf(end));

class Element {
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.style={};this.value='';this.className='';this.classes=new Set();this.classList={add:v=>this.classes.add(v),remove:v=>this.classes.delete(v),toggle:(v,on)=>on?this.classes.add(v):this.classes.delete(v)};}
    append(...nodes){this.children.push(...nodes);for(const node of nodes)if(node instanceof Element)node.parent=this;}
    replaceChildren(...nodes){this.children=[];this.append(...nodes);}
    setAttribute(name,value){this[name]=value;}
    querySelectorAll(selector){return this.children.flatMap(n=>n instanceof Element?[...(selector==='[data-folder-path]'&&n.dataset.folderPath!==undefined?[n]:[]),...n.querySelectorAll(selector)]:[]);}
    querySelector(){return null;}
    addEventListener(){}
    remove(){}
    insertBefore(node){this.append(node);}
}

async function fixture(t){
    const f=await createFixture();t.after(()=>f.close());const drive=f.api.spaces.get('');
    drive.createDirectory('alice','1/2',30);drive.createDirectory('bob','backup/a/deep',30);drive.createDirectory('bob','target/child',30);
    const call=async(user,route,method='GET',body)=>{const r=await fetch(f.base+'/api/telegram/drive'+route,{method,headers:{'X-Test-User':user,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;};
    const invite=async(kind,pathOrId)=>{const r=await call('bob','/collaborations/invitations','POST',kind==='directory'?{kind,path:pathOrId}:{kind,fileId:pathOrId});await call('alice','/collaborations/join','POST',{token:r.url.split('/').at(-1)});return r.collaboration;};
    const grant=await invite('directory','backup'),target=await invite('directory','target');
    const mount=(await call('alice','/mounts','POST',{parentPath:'1/2',name:'fuck',collaborationId:grant.id})).mount;
    const requests=[],window={},nodes=new Map(),document={createElement:tag=>new Element(tag),createTextNode:v=>v,getElementById:id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},querySelector:()=>new Element()};
    const context=vm.createContext({window,document,location:{origin:f.base},URL,URLSearchParams,Blob,AbortController,AbortSignal,Date,TextEncoder,TextDecoder,console,encodeURIComponent,setTimeout,clearTimeout,setInterval:(fn,ms)=>{const timer=setInterval(fn,ms);timer.unref();return timer;},clearInterval,fetch:async(url,options={})=>{requests.push({url,options});return fetch(new URL(url,f.base),{...options,headers:{...options.headers,'X-Test-User':'alice'}});},requestAnimationFrame:fn=>fn(),alert:m=>{throw Error(m);}});
    vm.runInContext(fs.readFileSync('client/disk-client.js','utf8'),context);
    t.after(()=>window.DiskClient.stop());
    return {...f,drive,call,invite,grant,target,mount,window,context,document,requests};
}

test('挂载内旧完整 API 路径进入实际来源，跨协同树入口不被重复拼接',async t=>{
    const f=await fixture(t),client=f.window.DiskClient;client.setMount(f.mount.id);
    const file=await client.raw('/api/telegram/drive/files/file-b');assert.equal(file.id,'file-b');
    await client.request('/api/telegram/drive/files/file-b',client.json('PATCH',{name:'修改真实来源.har'}));
    assert.equal(f.drive.get('bob','file-b').name,'修改真实来源.har');assert.equal(f.drive.get('alice','file-a').name,'相同.har');
    const targetTree=await client.raw('/collaboration-scope/'+f.target.id+'/directories');assert.ok(targetTree.directories.some(d=>d.path==='target/child'));
    assert.ok(f.requests.some(r=>r.url==='/api/telegram/drive/mount-scope/'+f.mount.id+'/files/file-b'));
    assert.ok(f.requests.some(r=>r.url==='/api/telegram/drive/collaboration-scope/'+f.target.id+'/directories'));
    const share=await client.request('/api/telegram/drive/shares',client.json('POST',{items:[{kind:'file',id:'file-b'}]}));assert.ok(share.url);
    assert.equal((await client.raw('/api/telegram/drive/shares')).shares.length,1);
    assert.equal((await f.call('bob','/shares')).shares.length,0);
    const copy=await client.raw('/cross-scope/copy',client.json('POST',{mode:'copy',source:{kind:'collaboration',collaborationId:f.grant.id,selection:{kind:'file',id:'file-b'}},target:{kind:'collaboration',collaborationId:f.target.id,destinationPath:'target/child'}}));assert.equal(copy.copied.length,1);f.repository.assertIntegrity();
});

test('挂载面包屑完整保留原生父路径，原生入口退出挂载且不注册错误的拖放目标',async()=>{
    const target=new Element(),drops=[],opened=[];
    const context=vm.createContext({document:{getElementById:()=>target,createElement:tag=>new Element(tag)},telegramDriveMountContext:{parentPath:'1/2',mount:{name:'fuck'},grant:{path:'backup'}},installDiskDrop:(node,path)=>drops.push(path),exitTelegramDriveMount:async path=>opened.push(path),navigateTelegramDrive:async path=>opened.push(path),requestAnimationFrame:fn=>fn(),alert(){}});
    vm.runInContext(section('function renderTelegramDriveBreadcrumbs(', 'function initDiskBreadcrumbScroll('),context);
    vm.runInContext('renderTelegramDriveBreadcrumbs({breadcrumbs:[{name:"backup",path:"backup"},{name:"a",path:"backup/a"}]})',context);
    const buttons=target.children.filter(n=>n.tagName==='BUTTON');assert.deepEqual(buttons.map(n=>n.textContent),['根目录','1','2','fuck','a']);
    assert.deepEqual(drops,['backup','backup/a']);await buttons[1].onclick();assert.deepEqual(opened,['1']);
});

test('目录选择器切换协同根和原生分区后显示真实多层树并提交正确路径',async()=>{
    const window={},context=vm.createContext({window,document:{createElement:tag=>new Element(tag)},alert(){}});
    vm.runInContext(fs.readFileSync('client/disk-directory-picker.js','utf8'),context);
    let scope={path:'backup',name:'fuck'},reload;
    const result=await window.DiskDirectoryPicker.choose({rootPath:'backup',rootName:'fuck',getRoot:()=>scope,initialPath:'backup',loadDirectories:async()=>({directories:scope.path?[{path:'backup',name:'backup'},{path:'backup/a',name:'a'},{path:'backup/a/deep',name:'deep'}]:[{path:'',name:'根目录'},{path:'mine',name:'mine'}]}),createDirectory:async path=>({path}),onReady:fn=>{reload=fn;},openDialog:async options=>{
        const tree=options.body.find(n=>n.className==='disk-destination-tree');let buttons=tree.querySelectorAll('[data-folder-path]');assert.deepEqual(buttons.map(n=>n.dataset.folderPath),['backup','backup/a','backup/a/deep']);
        buttons[2].onclick({preventDefault(){}});assert.equal(await options.validate(),'backup/a/deep');
        scope={path:'',name:'根目录'};await reload();buttons=tree.querySelectorAll('[data-folder-path]');assert.deepEqual(buttons.map(n=>n.dataset.folderPath),['','mine']);buttons[1].onclick({preventDefault(){}});assert.equal(await options.validate(),'mine');
        scope={path:'backup',name:'fuck'};await reload();buttons=tree.querySelectorAll('[data-folder-path]');buttons[1].onclick({preventDefault(){}});return options.validate();
    }});assert.equal(result,'backup/a');
});

test('挂载静态设置提交挂载类型，数字签名仅属于挂载者',async t=>{
    const f=await fixture(t),body=[];Object.assign(f.context,{telegramDriveStaticExpiryControls:()=>()=>({preset:'day'}),staticLinksForItem:()=>[],isTelegramDriveStaticOpen:()=>false,telegramDriveStaticUrl:()=>'/url',refreshTelegramDriveStaticLinks:async()=>{},openTelegramDriveDialog:async options=>{body.push(options);return body.length===1?options.validate():null;}});
    vm.runInContext(section('async function showTelegramDriveStaticSettings(', 'async function createTelegramDriveStaticLink('),f.context);
    await vm.runInContext('showTelegramDriveStaticSettings(item)',Object.assign(f.context,{item:{...f.mount,kind:'collaboration_mount'}}));
    const submitted=f.requests.find(r=>r.url.includes('/static-resources/settings'));assert.equal(JSON.parse(submitted.options.body).item.kind,'collaboration_mount');
    const links=(await f.call('alice','/static-resources')).links;assert.equal(links[0].mounts[0],f.mount.id);assert.equal((await f.call('bob','/static-resources')).links.length,0);
});

test('单文件挂载直接预览，不切换原生列表；读取地址保留独立授权入口',async t=>{
    const f=await fixture(t),grant=await f.invite('file','file-b'),mount=(await f.call('alice','/mounts','POST',{parentPath:'1/2',name:'叶子挂载',collaborationId:grant.id})).mount;
    const previews=[];Object.assign(f.context,{telegramDrivePath:'1/2',telegramDriveMountContext:null,openDiskPreview:async(item,options)=>previews.push({item,options}),navigateTelegramDrive:()=>{throw Error('不能进入单文件挂载伪目录');},clearTelegramDriveSelection:()=>{throw Error('不应重置原目录选择');}});
    vm.runInContext(section('async function openTelegramDriveMount(', 'async function openTelegramDriveMountedSearchResult('),f.context);
    await vm.runInContext('openTelegramDriveMount(item)',Object.assign(f.context,{item:{...mount,status:'active'}}));assert.equal(previews[0].options.single,true);assert.equal(previews[0].item.id,'file-b');assert.equal(f.window.DiskClient.getMount(),'');assert.equal(f.context.telegramDrivePath,'1/2');
    assert.match(f.window.DiskClient.streamUrl(previews[0].item),new RegExp('/mount-scope/'+mount.id+'/files/file-b/stream'));
    const link=(await f.call('alice','/static-resources/settings','POST',{item:{kind:'collaboration_mount',id:mount.id},preset:'day'})).link;
    assert.equal((await fetch(f.base+'/s3pub/'+link.token+'/mount/'+mount.id+'/',{method:'HEAD'})).status,200);
    assert.ok(f.drive.get('bob','file-b'));
});

test('回收站按原始文件快照显示并还原路径；管理员删除实体后移除节点不回收正文',async t=>{
    const f=await fixture(t);f.drive.createDirectory('alice','1/2/3',30);f.drive.update('alice','file-a',{folderPath:'1/2/3'});
    const deleted=await f.call('alice','/files/file-a','DELETE');await f.window.DiskClient.wait(deleted.operation_id);
    const records=f.repository.load('trash_items');records[0].originalParent='错误的旧摘要';records[0].path='';f.repository.replace('trash_items',records,i=>i.id);
    const item=(await f.call('alice','/trash')).items[0];assert.equal(item.originalPath,'1/2/3/相同.har');assert.equal(item.originalParent,'1/2/3');
    const restored=(await f.call('alice','/trash/'+item.id+'/restore','POST',{})).restored;assert.equal(restored.parentPath,'1/2/3');assert.equal(f.drive.get('alice','file-a').folderPath,'1/2/3');
    for(const [user,id] of [['alice','file-a'],['bob','file-b'],['alice','file-photo']]){const r=await fetch(f.base+'/api/telegram/disk-admin/reviews/'+id,{method:'PATCH',headers:{'X-Test-Admin':'1','Content-Type':'application/json'},body:JSON.stringify({user_id:user,disk_space:id==='file-photo'?'相册&照片':'',action:'delete'})});assert.equal(r.status,200);}
    const before=(await f.call('alice','/trash')).items.length;
    const removed=await f.call('alice','/files/file-a','DELETE');await f.window.DiskClient.wait(removed.operation_id);
    assert.equal((await f.call('alice','/trash')).items.length,before);assert.equal(f.drive.get('alice','file-a'),null);f.repository.assertIntegrity();
});
