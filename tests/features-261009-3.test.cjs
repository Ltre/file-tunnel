'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {Readable}=require('node:stream');
const {createFixture}=require('./support/disk-content-admin-fixture.cjs');
const json=body=>({headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
async function fixture(t){const f=await createFixture({telegram:{parts:file=>file.parts,readPart:async(_backend,_part,{start,end})=>Readable.from([Buffer.from('shared-fixture').subarray(start,end+1)]),upload:async(_backend,files)=>files.map(file=>({fileId:'edited',messageId:900,parts:file.size?[{offset:0,size:file.size,fileId:'edited',messageId:900,messageDate:Date.now()}]:[]}))}});t.after(()=>f.close());f.drive=f.api.spaces.get('');f.drive.createDirectory('alice','资料/同名',30);f.drive.createDirectory('bob','backup',30);f.call=async(user,route,method='GET',body,headers={})=>{const response=await fetch(f.base+'/api/telegram/drive'+route,{method,...(body!==undefined?json(body):{}),headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),'X-Test-User':user,...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};f.invite=async(path)=>{const created=await f.call('bob','/collaborations/invitations','POST',{kind:'directory',path});assert.equal(created.status,201,JSON.stringify(created.data));const joined=await f.call('alice','/collaborations/join','POST',{token:created.data.url.split('/').at(-1)});assert.equal(joined.status,200,JSON.stringify(joined.data));return created.data.collaboration.id;};f.mount=async(id,name='挂载')=>{const r=await f.call('alice','/mounts','POST',{parentPath:'资料',name,collaborationId:id});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.mount;};f.terminal=async(id,route='')=>{for(let n=0;n<100;n++){const r=await f.call('alice',route+'/operations/'+id);if(['failed','completed','cancelled'].includes(r.data.status))return r.data;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('timeout');};return f;}

test('回收站原始资料及旧错误摘要，不改变内容引用',async t=>{
    const f=await fixture(t),file=f.drive.get('alice','file-a'),refs=f.repository.content.references(f.sharedId).length;
    const response=await f.call('alice','/files/file-a','DELETE');assert.equal((await f.terminal(response.data.operation_id)).status,'completed');
    let item=(await f.call('alice','/trash')).data.items[0];assert.equal(item.name,'相同.har');assert.equal(item.originalPath,'资料/同名/相同.har');assert.equal(item.type,file.type);assert.equal(item.size,file.size);
    const records=f.repository.load('trash_items');records[0].name=':recycle:file-a';f.repository.replace('trash_items',records,i=>i.id);
    item=(await f.call('alice','/trash')).data.items[0];assert.equal(item.name,'相同.har');assert.equal(f.repository.content.references(f.sharedId).length,refs);
});

test('挂载原地路由、viewer 分享、静态指针改名移动删除与撤权',async t=>{
    const f=await fixture(t),grant=await f.invite('backup'),mount=await f.mount(grant),route='/mount-scope/'+mount.id;
    assert.equal((await f.call('alice',route+'/list?path=backup')).data.files[0].id,'file-b');
    assert.equal((await f.call('alice',route+'/files/file-a')).status,403);
    const link=(await f.call('alice','/static-resources/settings','POST',{item:{kind:'collaboration_mount',id:mount.id},preset:'day'})).data.link;assert.ok(link.token);
    const staticHead=await fetch(f.base+'/s3pub/'+link.token+'/mount/'+mount.id+'/相同.har',{method:'HEAD'});assert.equal(staticHead.status,200);
    const renamed=await f.call('alice','/mounts/'+mount.id,'PATCH',{name:'新名称'});assert.equal(renamed.status,200);
    assert.equal((await fetch(f.base+'/s3pub/'+link.token+'/mount/'+mount.id+'/相同.har',{method:'HEAD'})).status,200);
    const moved=await f.call('alice','/mounts/'+mount.id,'PATCH',{parentPath:'资料/同名'});assert.equal(moved.status,200);
    await f.call('bob','/collaborations/'+grant+'/members/alice','PATCH',{role:'viewer'});
    assert.equal((await f.call('alice',route+'/files/file-b','PATCH',{name:'拒绝'})).status,403);
    const share=await f.call('alice',route+'/shares','POST',{items:[{kind:'file',id:'file-b'}]});assert.equal(share.status,201,JSON.stringify(share.data));
    assert.equal((await f.call('bob','/shares')).data.shares.length,0);assert.equal((await f.call('alice','/shares')).data.shares.length,1);
    assert.equal((await fetch(f.base+'/api/telegram/drive/shares/'+share.data.url.split('/').at(-1))).status,200);
    assert.equal((await f.call('alice','/mounts/'+mount.id,'DELETE')).status,200);
    assert.ok(f.drive.get('bob','file-b'));assert.notEqual((await fetch(f.base+'/s3pub/'+link.token+'/mount/'+mount.id+'/相同.har',{method:'HEAD'})).status,200);
    assert.notEqual((await fetch(f.base+'/api/telegram/drive/shares/'+share.data.url.split('/').at(-1))).status,200);
});

test('S3 挂载全部只读，包括不存在的后代和祖先删除',async t=>{
    const f=await fixture(t),grant=await f.invite('backup'),mount=await f.mount(grant),mapping={userId:'alice',diskSpace:''},storage=f.api.objectStorage;
    const prefix='资料/'+mount.name;assert.ok(storage.list(mapping).some(o=>o.key===prefix+'/相同.har'));
    assert.equal(storage.stat(mapping,prefix+'/相同.har').file.id,'file-b');
    await assert.rejects(storage.put(mapping,prefix+'/new.txt',Readable.from([]),{size:0}),/MOUNT_READ_ONLY/);
    await assert.rejects(storage.remove(mapping,prefix+'/missing'),/MOUNT_READ_ONLY/);
    await assert.rejects(storage.remove(mapping,'资料/'),/MOUNT_READ_ONLY/);
    await storage.put(mapping,'普通.txt',Readable.from([]),{size:0});assert.ok(storage.stat(mapping,'普通.txt'));
});

test('跨协同移动提交目标后归档真实来源，重复请求不重复复制',async t=>{
    const f=await fixture(t),grant=await f.invite('backup');
    const input={requestId:'move-test-123',source:{kind:'collaboration',collaborationId:grant,selection:{kind:'file',id:'file-b'}},target:{kind:'native',destinationPath:'资料'}};
    const moved=await f.call('alice','/cross-scope/move','POST',input);assert.equal(moved.status,201,JSON.stringify(moved.data));assert.equal(moved.data.state,'COMPLETED');
    assert.equal(f.drive.get('bob','file-b'),null);assert.ok(f.drive.get('alice',moved.data.copied[0].id));
    assert.equal((await f.call('bob','/trash')).data.items[0].name,'相同.har');assert.equal((await f.call('alice','/trash')).data.items.length,0);
    const again=await f.call('alice','/cross-scope/move','POST',input);assert.equal(again.data.copied[0].id,moved.data.copied[0].id);
});

test('跨协同根移动：复制成功、受保护来源保留，重试不新增副本',async t=>{
    const f=await fixture(t),grant=await f.invite('backup');
    const input={requestId:'move-root-123',source:{kind:'collaboration',collaborationId:grant,selection:{kind:'directory',path:'backup'}},target:{kind:'native',destinationPath:'资料'}};
    const r=await f.call('alice','/cross-scope/move','POST',input);assert.equal(r.data.state,'COPIED_SOURCE_RETAINED');assert.equal(r.data.warning.code,'COLLABORATION_DISABLE_BEFORE_DELETE');assert.ok(f.drive.get('bob','file-b'));
    const again=await f.call('alice','/cross-scope/move','POST',input);assert.equal(again.data.copied[0].id,r.data.copied[0].id);
});

test('个人全局深度与目录上传清单限制、空目录及独立分批',async t=>{
    const f=await fixture(t);
    assert.equal((await f.call('alice','/settings')).data.settings.maxDirectoryDepth,30);
    const path=Array.from({length:30},(_,i)=>'d'+i).join('/');f.drive.createDirectory('alice',path,30);assert.throws(()=>f.drive.createDirectory('alice',path+'/多一层',30),/depth/);
    await f.call('alice','/settings','PATCH',{maxDirectoryDepth:3,folderUploadMaxBytes:100});assert.ok(f.drive.getDirectory('alice',path));
    const rejected=await f.call('alice','/folder-uploads','POST',{directories:['新目录'],files:[{folderPath:'新目录',name:'large',size:101}]});assert.equal(rejected.data.error,'FOLDER_UPLOAD_TOO_LARGE');assert.equal(f.drive.getDirectory('alice','新目录'),null);
    const created=await f.call('alice','/folder-uploads','POST',{directories:['新目录','新目录/空目录'],files:[{folderPath:'新目录',name:'a.txt',size:0}]});assert.equal(created.status,201,JSON.stringify(created.data));assert.ok(f.drive.getDirectory('alice','新目录/空目录'));
    const batch=await f.call('alice','/uploads','POST',{metadata:{folderUploadId:created.data.id},files:[{folderPath:'新目录',name:'a.txt',size:0}],folderPath:'新目录'});assert.equal(batch.status,201,JSON.stringify(batch.data));
});

test('原生编辑 COW 保持另一引用，版本冲突拒绝覆盖',async t=>{
    const f=await fixture(t),before=f.drive.get('alice','file-a');
    const body=Buffer.from('new body');const response=await fetch(f.base+'/api/telegram/drive/files/file-a/content',{method:'PUT',headers:{'X-Test-User':'alice','X-Disk-File-Size':String(body.length),'X-Disk-Expected-Version':String(before.logicalContentVersion),'X-Disk-File-Type':'text/plain'},body});const data=await response.json();assert.equal(response.status,202,JSON.stringify(data));
    const done=await f.terminal(data.operation_id);assert.equal(done.status,'completed',JSON.stringify(done));
    assert.notEqual(f.drive.get('alice','file-a').contentId,f.sharedId);assert.equal(f.drive.get('bob','file-b').contentId,f.sharedId);
    const stale=await fetch(f.base+'/api/telegram/drive/files/file-a/content',{method:'PUT',headers:{'X-Test-User':'alice','X-Disk-File-Size':'0','X-Disk-Expected-Version':'1'},body:''});assert.equal((await stale.json()).error,'CONTENT_WRITE_CONFLICT');f.repository.assertIntegrity();
});

test('十六进制按字节保存，Markdown 预览不执行 HTML',()=>{
    const ctx=vm.createContext({window:{},Uint8Array,TextEncoder,TextDecoder});vm.runInContext(fs.readFileSync('client/disk-file-editor.js','utf8'),ctx);
    assert.deepEqual([...ctx.window.DiskFileEditor._test.bytesFromHex('00 7F 80 FF')],[0,127,128,255]);assert.throws(()=>ctx.window.DiskFileEditor._test.bytesFromHex('F'));assert.throws(()=>ctx.window.DiskFileEditor._test.bytesFromHex('ZZ'));
    assert.ok(ctx.window.DiskFileEditor._test.markdown('<script>alert(1)</script>').includes('&lt;script&gt;'));
});

test('挂载授权内部合法复制；外部 API 的路径、批量和显式挂载路由全部只读',async t=>{
    const f=await fixture(t),grant=await f.invite('backup'),mount=await f.mount(grant);
    f.drive.createDirectory('bob','backup/copies',30);
    const copied=await f.call('alice','/cross-scope/copy','POST',{mode:'copy',source:{kind:'collaboration',collaborationId:grant,selection:{kind:'file',id:'file-b'}},target:{kind:'collaboration',collaborationId:grant,destinationPath:'backup/copies'}});
    assert.equal(copied.status,201,JSON.stringify(copied.data));assert.equal(f.drive.list('bob','backup/copies').files.length,1);
    const auth=f.auth;
    await auth.saveApp({app_id:'readonly-test',app_secret:'long-test-secret'});
    const verified=await auth.authenticateApp('readonly-test','long-test-secret');
    const token=auth.issueToken(verified,{token:'fixture-only',channelId:'-1001234567890',baseUrl:'https://example.test'}).access_token;
    const external=async(route,method='GET',body)=>{const response=await fetch(f.base+'/api/telegram/disk/v1'+route,{method,headers:{Authorization:'Bearer '+token,'X-Disk-User-Id':'alice',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
    assert.equal((await external('/list?path='+encodeURIComponent('资料/挂载'))).data.files[0].id,'file-b');
    assert.equal((await external('/mount-scope/'+mount.id+'/files/file-b')).status,200);
    for(const [route,method,body] of [
        ['/directories','POST',{path:'资料/挂载/new'}],
        ['/directories?path='+encodeURIComponent('资料'),'DELETE'],
        ['/uploads','POST',{folderPath:'资料',files:[{name:'new',folderPath:'资料/挂载/missing',size:0}]}],
        ['/mount-scope/'+mount.id+'/files/file-b','PATCH',{name:'changed'}]
    ])assert.equal((await external(route,method,body)).data.error,'MOUNT_READ_ONLY');
    assert.equal((await external('/directories','POST',{path:'ordinary-api-directory'})).status,202);
    assert.equal((await external('/uploads','POST',{folderPath:'资料',files:[{name:'ordinary-api-file',size:0}]})).status,201);
    assert.equal((await external('/uploads','POST',{files:[{source_path:'/资料/挂载/new.txt',size:0}]})).data.error,'MOUNT_READ_ONLY');
});

test('目录上传超过 100 文件分两批，持久清单约束总量且拒绝重复成功批次',async t=>{
    const f=await fixture(t),files=Array.from({length:101},(_,index)=>({name:'file-'+index+'.txt',folderPath:'批次目录',size:0,type:'text/plain'}));
    const manifest=await f.call('alice','/folder-uploads','POST',{directories:['批次目录','批次目录/空目录'],files});
    assert.equal(manifest.status,201);
    for(const batch of [files.slice(0,100),files.slice(100)]){
        const job=await f.call('alice','/uploads','POST',{folderPath:'批次目录',files:batch,metadata:{folderUploadId:manifest.data.id}});
        assert.equal(job.status,201,JSON.stringify(job.data));
        for(let index=0;index<batch.length;index++){
            const r=await fetch(f.base+'/api/telegram/drive/uploads/'+job.data.uploadId+'/files/'+index,{method:'PUT',body:''});
            assert.equal(r.status,200);
        }
        const result=await f.call('alice','/uploads/'+job.data.uploadId+'/finish','POST',{});
        assert.equal((await f.terminal(result.data.operation_id)).status,'completed');
    }
    assert.equal(f.drive.list('alice','批次目录').files.length,101);
    const status=(await f.call('alice','/folder-uploads/'+manifest.data.id)).data;
    assert.equal(status.batches.filter(batch=>batch.completed).length,2);
    assert.equal((await f.call('alice','/uploads','POST',{folderPath:'批次目录',files:[files[0]],metadata:{folderUploadId:manifest.data.id}})).data.error,'FOLDER_UPLOAD_BATCH_CONFLICT');
    f.repository.assertIntegrity();
});

test('编辑未变正文不发送 Telegram；新建保存失败不留下空文件',async t=>{
    const f=await fixture(t),version=f.drive.get('alice','file-a').logicalContentVersion;
    const unchanged=await fetch(f.base+'/api/telegram/drive/files/file-a/content',{method:'PUT',headers:{'X-Disk-File-Size':'14','X-Disk-Expected-Version':String(version),'X-Disk-File-Type':'text/plain'},body:'shared-fixture'});
    const result=await unchanged.json();assert.equal((await f.terminal(result.operation_id)).result.unchanged,true);
    assert.equal(f.drive.get('alice','file-a').contentId,f.sharedId);
    const failed=await fetch(f.base+'/api/telegram/drive/files/content?folderPath='+encodeURIComponent('资料')+'&name=failed.txt',{method:'POST',headers:{'X-Disk-File-Size':'20000001'},body:''});
    assert.equal((await failed.json()).error,'FILE_EDIT_TOO_LARGE');assert.equal(f.drive.list('alice','资料').files.length,0);
    f.repository.assertIntegrity();
});

test('导入按钮持续 Loading 到草稿保存结束，保存中取消向回调传递并复位',async()=>{
    class Node{constructor(){this.children=[];this.style={};const classes=new Set();this.classList={add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)};}append(...n){this.children.push(...n);}replaceChildren(){this.children=[];}setAttribute(){}addEventListener(){}showModal(){}close(){}remove(){}}
    for(const cancel of [false,true]){
        const body=new Node(),window={DiskClient:{getSpace:()=>'',raw:async path=>path==='/spaces'?{spaces:[{name:'默认分区',scopeKey:''}]}:{files:[{kind:'file',id:'f',name:'a.txt',size:1}]}},DiskErrorMessages:{format:e=>e.message}};
        let saving,finishSave;const ready=new Promise(resolve=>{saving=resolve;});
        vm.runInNewContext(fs.readFileSync('client/disk-import-picker.js','utf8'),{window,document:{body,createElement:()=>new Node(),addEventListener(){},removeEventListener(){}},AbortController,Uint8Array,Map,Set,Number,Error,fetch:async()=>({ok:true,body:{getReader:()=>{let read=false;return {read:async()=>read?{done:true}:(read=true,{value:new Uint8Array([65]),done:false})};}}})});
        const selected=window.DiskImportPicker.choose({onImport:async(_entries,signal)=>{saving();await new Promise((resolve,reject)=>{finishSave=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});}});
        for(let n=0;n<8;n++)await Promise.resolve();
        const dialog=body.children.at(-1),check=dialog.children[1].children[0].children[0],footer=dialog.children[3],accept=footer.children[1];check.checked=true;check.onchange();
        const running=accept.onclick();await ready;
        assert.equal(accept.disabled,true);assert.equal(accept.classList.contains('disk-import-busy'),true);
        if(cancel)footer.children[0].onclick();else finishSave();
        const result=await selected;await running;
        assert.equal(accept.disabled,false);assert.equal(accept.classList.contains('disk-import-busy'),false);assert.equal(cancel?result===null:result[0].data[0]===65,true);
    }
});

test('目录上传中断后重新选择同批来源，只继续未完成文件',async()=>{
    const storage=new Map(),calls=[],answers=[true,false,true,true];let parent;
    class File{constructor(parts,name,{type}){this.name=name;this.type=type;this.size=parts[0].size;}}
    const context={requestBase:'/api/telegram/drive',diskSpace:''};
    const window={DiskClient:{context:()=>context,json:(method,body)=>({method,body:JSON.stringify(body)}),raw:async(path,options)=>{
        if(path==='/limits')return {settings:{folderUploadMaxBytes:500000000,maxDirectoryDepth:30}};
        if(path==='/folder-uploads'){const data=JSON.parse(options.body);parent={...data,id:'parent',batches:[]};return parent;}
        if(path==='/folder-uploads/parent')return parent;throw Error(path);
    },upload:async(files,_path,_read,metadata)=>{calls.push(files.map(f=>f.name));assert.equal(metadata.folderUploadId,'parent');if(calls.length===2)throw Error('NETWORK_INTERRUPTED');parent.batches.push({completed:true,status:'completed',keys:files.map(f=>f.diskFolderPath+'/'+f.name)});}},DiskErrorMessages:{format:e=>e.message}};
    vm.runInNewContext(fs.readFileSync('client/disk-folder-upload.js','utf8'),{window,File,localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},confirm:()=>answers.shift(),Set,Array,JSON,Error});
    const plan={directories:['folder'],files:Array.from({length:101},(_,i)=>({file:{name:i+'.txt',type:'text/plain',size:1},path:'folder/'+i+'.txt'}))};
    await assert.rejects(window.DiskFolderUpload.upload(plan,''),/NETWORK_INTERRUPTED/);
    const completed=await window.DiskFolderUpload.upload(plan,'');assert.equal(completed.completed,101);assert.equal(calls.length,3);assert.deepEqual([...calls[2]],['100.txt']);
});
