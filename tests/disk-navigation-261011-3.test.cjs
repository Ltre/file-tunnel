'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('client/disk-ui.js','utf8');
const turn=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
class Element {
    constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.attrs={};this.listeners={};this.scrollTop=0;this.classList={add(){},remove(){},toggle(){}};}
    append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;}
    setAttribute(key,value){this.attrs[key]=value;} removeAttribute(key){delete this.attrs[key];}
    contains(node){return this.children.includes(node)||this.children.some(child=>child.contains?.(node));} focus(){this.focused=true;} select(){this.selected=true;}
    requestSubmit(){return this.onsubmit({preventDefault(){}});}
    addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);} emit(name,event={}){for(const fn of this.listeners[name]||[])fn({...event,type:name});}
}
function fixture(handler=async()=>({})){
    const elements=new Map(),calls=[],toasts=[],contexts=[];
    const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
    let space='',mount='';
    const client={getSpace:()=>space,setSpace:value=>{space=value;mount='';},setMount:value=>{mount=value;contexts.push(value);},
        getAccount:()=> 'fixture-account',hasActiveOperations:()=>false,raw:async(url,options={})=>{calls.push({url,options});return handler(url,options);},context:()=>({accountId:'fixture-account',requestBase:'/api/telegram/drive'+(mount?'/mount-scope/'+mount:''),diskSpace:space})};
    const context=vm.createContext({window:{DiskClient:client,addEventListener(){}},localStorage:{getItem(){},setItem(){}},
        document:{getElementById:get,createElement:tag=>new Element(tag),querySelector:()=>null,querySelectorAll:()=>[]},
        requestAnimationFrame:fn=>fn(),AbortController,URL,URLSearchParams,Map,Set,location:{origin:'http://localhost',href:'http://localhost/disk',search:''},
        history:{state:{},pushState(){}},setTimeout,clearTimeout,queueMicrotask,alert:message=>toasts.push(message)});
    const hook=`
    renderTelegramDriveItems=()=>document.getElementById('telegramDriveList').replaceChildren(...(telegramDriveCurrentData?.folders||[]).map(p=>Object.assign(document.createElement('div'),{textContent:p.name})));
    showAppToast=message=>window.test.toasts.push(message);
    renderTelegramDrive=async()=>{telegramDriveCurrentData=await window.DiskClient.raw('/list?path='+encodeURIComponent(telegramDrivePath));renderTelegramDriveBreadcrumbs(telegramDriveCurrentData);renderTelegramDriveItems();};
    clearTelegramDriveSearch=()=>{};clearTelegramDriveSelection=()=>{};closeTelegramDriveItemMenu=()=>{};updateTelegramDriveSelectionBar=()=>{};
    window.test={toasts:[],open:openTelegramDriveMount,cancel:cancelTelegramDrivePendingMount,exit:exitTelegramDriveMount,edit:editTelegramDrivePath,inputPath:navigateTelegramDriveInputPath,
        switchSpace(id){telegramDriveSpaces=[{id,scopeKey:id,name:id}];return switchTelegramDrivePartition(id);},
        set(data,path='1/2',mount=null){telegramDriveCurrentData=data;telegramDrivePath=path;telegramDriveMountContext=mount;renderTelegramDriveBreadcrumbs(data);renderTelegramDriveItems();},
        state(){return {path:telegramDrivePath,mount:telegramDriveMountContext,pending:!!telegramDrivePendingMount,data:telegramDriveCurrentData};}};
    `;
    vm.runInContext(source.replace('window.DiskUI = {',hook+'\nwindow.DiskUI = {'),context);
    const api=context.window.test;
    api.set({path:'1/2',breadcrumbs:[{name:'1',path:'1'},{name:'2',path:'1/2'}],folders:[{name:'原生内容'}]});
    return {api,client,get,calls,contexts,toasts:api.toasts};
}
const item={id:'mount-a',name:'协同目录',parentPath:'1/2',status:'active'};
const resolved={mount:item,collaboration:{id:'grant-a',kind:'directory',path:'源根',name:'远端名称'}};

test('挂载入口立即显示本地路径与行内加载，完成授权和列表请求后原子切换',async()=>{
    const resolve=deferred(),list=deferred();
    const f=fixture(url=>url.includes('/resolve')?resolve.promise:list.promise);
    const opening=f.api.open(item);
    assert.equal(f.api.state().pending,true);
    assert.deepEqual(f.get('telegramDriveBreadcrumbs').children.filter(n=>n.tagName==='button').map(n=>n.textContent),['根目录','1','2','协同目录','✎']);
    assert.equal(f.get('telegramDriveList').attrs['aria-busy'],'true');assert.equal(f.get('telegramDriveList').children[0].className,'disk-mount-opening');
    assert.equal(f.client.context().requestBase,'/api/telegram/drive','未验证的挂载上下文不能进入业务请求');
    assert.equal(f.get('telegramDriveBottom').inert,true,'授权期间不能向旧原生作用域提交底栏操作');
    resolve.resolve(resolved);await turn();assert.equal(f.api.state().mount,null);
    assert.equal(f.calls.at(-1).options.requestBase,'/api/telegram/drive/mount-scope/mount-a');
    list.resolve({path:'源根',folders:[{name:'协同内容'}],breadcrumbs:[{name:'源根',path:'源根'}]});await opening;
    assert.equal(f.api.state().pending,false);assert.equal(f.api.state().path,'源根');assert.equal(f.get('telegramDriveList').children[0].textContent,'协同内容');
    assert.equal(f.client.context().requestBase,'/api/telegram/drive/mount-scope/mount-a');assert.equal(f.get('telegramDriveCreateBtn').disabled,false);
    assert.equal(f.get('telegramDriveBottom').inert,false);
});

test('挂载正在加载时切换分区会中止旧请求，旧响应不能恢复原分区或锁住新视图',async()=>{
    const response=deferred(),f=fixture(url=>url.includes('/resolve')?response.promise:Promise.resolve({path:'',folders:[{name:'新分区内容'}]}));
    const opening=f.api.open(item),signal=f.calls[0].options.signal;
    await f.api.switchSpace('另一个分区');assert.equal(signal.aborted,true);assert.equal(f.api.state().pending,false);
    response.resolve(resolved);await opening;
    assert.equal(f.client.getSpace(),'另一个分区');assert.equal(f.api.state().mount,null);assert.equal(f.get('telegramDriveList').children[0].textContent,'新分区内容');
});

test('挂载授权或列表失败恢复原路径、内容及滚动位置；取消后的迟到响应不覆盖新导航',async()=>{
    for(const failAt of ['resolve','list']){
        const f=fixture(async url=>{if(url.includes('/resolve')&&failAt==='list')return resolved;throw Error('MOUNT_ACCESS_REVOKED');});
        f.get('telegramDriveList').scrollTop=140;await assert.rejects(f.api.open(item),/MOUNT_ACCESS_REVOKED/);
        assert.equal(f.api.state().mount,null);assert.equal(f.api.state().path,'1/2');assert.equal(f.get('telegramDriveList').scrollTop,140);
        assert.equal(f.get('telegramDriveList').children[0].textContent,'原生内容');assert.equal(f.get('telegramDriveCreateBtn').disabled,false);
    }
    const response=deferred(),f=fixture(url=>url.includes('/resolve')?response.promise:Promise.resolve({path:'另一个目录',folders:[{name:'新内容'}]}));
    const pending=f.api.open(item);const signal=f.calls[0].options.signal;
    await f.api.exit('另一个目录');assert.equal(signal.aborted,true);
    response.resolve(resolved);await pending;assert.equal(f.api.state().path,'另一个目录');assert.equal(f.api.state().mount,null);
});

test('手动路径默认完整路径且全选，Enter 导航，点击外部或 Esc 取消；无效路径不请求',async()=>{
    const f=fixture(async url=>url==='/mounts'?{mounts:[]}:{path:'中文/目录',folders:[]});
    f.api.edit();let form=f.get('telegramDriveBreadcrumbs').children[0],input=form.children[0];assert.equal(input.value,'/1/2');assert.ok(input.focused&&input.selected);
    form.emit('focusout');await turn();assert.equal(f.get('telegramDriveBreadcrumbs').contains(input),false);assert.equal(f.calls.length,0);
    f.api.edit();form=f.get('telegramDriveBreadcrumbs').children[0];input=form.children[0];input.value='/中文/目录';input.onkeydown({key:'Enter',preventDefault(){}});await turn();
    assert.equal(f.api.state().path,'中文/目录');assert.ok(f.calls.some(c=>c.url==='/directories/properties?path='+encodeURIComponent('中文/目录')));
    f.api.edit();input=f.get('telegramDriveBreadcrumbs').children[0].children[0];input.onkeydown({key:'Escape',preventDefault(){}});assert.equal(f.get('telegramDriveBreadcrumbs').contains(input),false);
    const count=f.calls.length;await assert.rejects(f.api.inputPath('/中文/../私有'),/不合法/);assert.equal(f.calls.length,count);
});

test('挂载手动路径使用本地别名和原生前缀，远端相对路径仍通过实际挂载授权读取',async()=>{
    const f=fixture(async url=>url==='/mounts'?{mounts:[item]}:url.includes('/resolve')?resolved:{path:'源根/中文',folders:[],breadcrumbs:[{name:'中文',path:'源根/中文'}]});
    f.api.set({folders:[]},'源根/子目录',{mount:item,grant:resolved.collaboration,parentPath:'1/2'});
    f.api.edit();assert.equal(f.get('telegramDriveBreadcrumbs').children[0].children[0].value,'/1/2/协同目录/子目录');
    await f.api.inputPath('/1/2/协同目录/中文');assert.equal(f.api.state().path,'源根/中文');
    const request=f.calls.find(c=>c.url==='/list?path='+encodeURIComponent('源根/中文'));
    assert.equal(request.options.requestBase,'/api/telegram/drive/mount-scope/mount-a');
});

test('移动键盘原生 submit 无需 keydown Enter；请求中失焦不丢掉路径输入',async()=>{
    const gate=deferred(),f=fixture(async url=>url==='/mounts'?gate.promise:{path:'56',folders:[]});
    f.api.edit();const form=f.get('telegramDriveBreadcrumbs').children[0],input=form.children[0];input.value='/56';
    input.onkeydown({key:'Enter',isComposing:true,preventDefault(){throw Error('不应截获中文候选确认');}});
    assert.equal(f.calls.length,0);
    const submitted=form.requestSubmit();form.emit('focusout');await turn();assert.ok(f.get('telegramDriveBreadcrumbs').contains(input));
    gate.resolve({mounts:[]});await submitted;assert.equal(f.api.state().path,'56');assert.equal(f.get('telegramDriveBreadcrumbs').contains(input),false);
});

test('前往按钮按下保留输入焦点，click 与 Enter 共用提交；键盘转移焦点到按钮不提前关闭',async()=>{
    const gate=deferred(),f=fixture(async url=>url==='/mounts'?gate.promise:{path:'56',folders:[]});
    f.api.edit();const form=f.get('telegramDriveBreadcrumbs').children[0],input=form.children[0],go=form.children[1];input.value='/56';
    let prevented=false;go.emit('pointerdown',{preventDefault(){prevented=true;}});assert.equal(prevented,true);
    form.emit('focusout',{relatedTarget:go});await turn();assert.ok(f.get('telegramDriveBreadcrumbs').contains(input));
    const pending=go.onclick({preventDefault(){}});form.emit('focusout');await turn();assert.ok(f.get('telegramDriveBreadcrumbs').contains(input));
    gate.resolve({mounts:[]});await pending;await turn();assert.equal(f.api.state().path,'56');
});

test('加号菜单的新建文件接入当前目录已有编辑器，owned 协同位置支持触摸长按且滚动不会误触',async()=>{
    const page=fs.readFileSync('pages/index.html','utf8');assert.match(page,/id="telegramDriveCreateMenu"[^>]*>[\s\S]*?id="telegramDriveNewFileBtn"/);
    const start=source.indexOf("    document.getElementById('telegramDriveNewFileBtn')?.addEventListener"),end=source.indexOf("    document.getElementById('telegramDriveFileInput')",start);
    const f=fixture(),opened=[];
    const hook=vm.createContext({document:{getElementById:f.get},window:{DiskFileEditor:{open:async options=>opened.push(options)}},telegramDrivePath:'中文/当前位置',openTelegramDriveDialog(){},refreshTelegramDriveContents(){},alert(){},telegramDriveErrorText:e=>e.message});
    vm.runInContext(source.slice(start,end),hook);f.get('telegramDriveNewFileBtn').emit('click');await turn();
    assert.equal(f.get('telegramDriveCreateMenu').hidden,true);assert.equal(opened[0].path,'中文/当前位置');
    let callback,timer;const button=new Element('button'),messages=[];
    const gestures=vm.createContext({setTimeout:fn=>{callback=fn;timer=true;return 1;},clearTimeout:()=>{timer=false;},Date,Map});
    vm.runInContext(source.slice(source.indexOf('function installContextGesture('),source.indexOf('\nfunction installDiskDrop(')),gestures);
    gestures.installContextGesture(button,()=>messages.push('/实际所在目录'),null,{accept:()=>true});
    button.emit('pointerdown',{pointerType:'touch',isPrimary:true,button:0,pointerId:1,clientX:0,clientY:0});assert.ok(timer);callback();
    assert.deepEqual(messages,['/实际所在目录']);let suppressed=false;button.emit('click',{preventDefault(){},stopImmediatePropagation(){suppressed=true;}});assert.equal(suppressed,true);
    button.emit('pointerup',{pointerId:1});button.emit('pointerdown',{pointerType:'touch',isPrimary:true,button:0,pointerId:2,clientX:0,clientY:0});button.emit('pointermove',{pointerId:2,clientX:0,clientY:50});assert.equal(timer,false,'正常纵向滚动要取消长按提示');
});
