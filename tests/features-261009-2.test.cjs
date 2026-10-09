'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createFixture}=require('./support/disk-content-admin-fixture.cjs');
const messages=require('../client/disk-error-messages');
const {diskOperationError,diskUserMessage,diskErrorDetails}=require('../server/disk-errors');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
async function call(f,user,route,method='GET',body){const res=await fetch(f.base+'/api/telegram/drive'+route,{method,headers:{'X-Test-User':user,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};}
async function done(f,user,result,suffix=''){if(result.status!==202)return result;for(let i=0;i<100;i++){const next=await call(f,user,'/operations/'+result.data.operation_id+suffix);if(['completed','failed','cancelled'].includes(next.data.status))return next;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('operation did not settle');}
test('错误原因可读但保持稳定错误码，底层错误不输出 SQL 或敏感细节',()=>{
    const error=diskOperationError('CONTENT_COPY_SCOPE_INVALID','DESTINATION_INSIDE_SOURCE',{sourcePath:'目录 M',targetPath:'目录 M/N',token:'private-token',serverPath:'C:/secret'});
    assert.equal(error.message,'CONTENT_COPY_SCOPE_INVALID');assert.match(diskUserMessage(error),/目录 M\/N.*来源目录内部/);
    const details=diskErrorDetails(error);assert.equal(details.reason,'DESTINATION_INSIDE_SOURCE');assert.equal(details.token,undefined);assert.equal(details.serverPath,undefined);
    assert.match(messages.format({message:error.message,userMessage:diskUserMessage(error),errorDetails:details}),/\[CONTENT_COPY_SCOPE_INVALID\]/);
    assert.doesNotMatch(diskUserMessage(Error('SQLITE constraint failed: C:/secret')),/SQLITE|secret|constraint/);
    assert.doesNotMatch(messages.format(Error('ENOENT: open C:\\Users\\private\\data')),/Users|private/);
    const batch=messages.format({message:'DISK_NAME_CONFLICT',batchProgress:{item:'第二个文件',completed:1,total:3,remaining:1}});assert.match(batch,/已确认完成 1\/3 项/);assert.match(batch,/后续 1 项未执行/);assert.match(batch,/\[DISK_NAME_CONFLICT\]/);
    for(const code of ['CONTENT_COPY_SOURCE_CHANGED','STATIC_RESOURCE_ACTIVE','MOUNT_TRANSFER_UNSUPPORTED','INVALID_CACHE_SCOPE','CONTENT_LEASE_EXPIRED'])assert.ok(messages.describe(code).length>15);
    for(const reason of Object.keys(messages.reasons))assert.ok(messages.format({message:'DISK_REQUEST_FAILED',errorDetails:{reason}}).includes(messages.reasons[reason]),reason);
});
test('两个受邀目录来自同一原生树，复制父目录到子目录返回具体原因',async t=>{
    t.mock.method(console,'info',()=>{});const f=await createFixture();t.after(()=>f.close());const drive=f.api.spaces.get('');
    drive.createDirectory('bob','backup/N',20);
    const ids=[];for(const path of ['backup','backup/N']){const created=await call(f,'bob','/collaborations/invitations','POST',{kind:'directory',path});assert.equal(created.status,201);const joined=await call(f,'alice','/collaborations/join','POST',{token:created.data.url.split('/').at(-1)});assert.equal(joined.status,200);ids.push(created.data.collaboration.id);}
    const result=await call(f,'alice','/cross-scope/copy','POST',{mode:'copy',source:{kind:'collaboration',collaborationId:ids[0],selection:{kind:'directory',path:'backup'}},target:{kind:'collaboration',collaborationId:ids[1],destinationPath:'backup/N'}});
    assert.equal(result.data.error,'CONTENT_COPY_SCOPE_INVALID');assert.equal(result.data.errorDetails.reason,'DESTINATION_INSIDE_SOURCE');assert.match(result.data.userMessage,/backup\/N/);assert.equal(drive.getDirectory('bob','backup/N/backup'),null);
});
test('文件删除进入当前分区回收站并保留引用；还原冲突、用户/分区隔离及重复还原',async t=>{
    t.mock.method(console,'info',()=>{});const f=await createFixture();t.after(()=>f.close());const drive=f.api.spaces.get('');drive.createDirectory('alice','资料/同名',20);
    const before=f.content.resolve(f.sharedId);
    const removed=await done(f,'alice',await call(f,'alice','/files/file-a','DELETE'));assert.equal(removed.data.status,'completed');assert.equal(drive.get('alice','file-a'),null);
    const list=await call(f,'alice','/trash');assert.equal(list.data.items.length,1);const id=list.data.items[0].id;
    assert.equal((await call(f,'bob','/trash')).data.items.length,0);assert.equal((await call(f,'bob',`/trash/${id}/restore`,'POST',{})).status,404);
    assert.equal((await call(f,'alice','/trash?disk_space='+encodeURIComponent('相册&照片'))).data.items.length,0);
    assert.equal(f.content.resolve(f.sharedId).state,before.state);assert.ok(f.repository.load('files').find(item=>item.id==='file-a').trashId);assert.equal(drive.adminFiles().some(item=>item.id==='file-a'),false);
    const conflict=drive.putMetadataObject({id:'alice'},'资料/同名','相同.har','text/plain',{},20);
    const blocked=await call(f,'alice',`/trash/${id}/restore`,'POST',{});assert.equal(blocked.status,409);assert.equal(blocked.data.error,'TRASH_RESTORE_CONFLICT');assert.match(blocked.data.userMessage,/同名/);assert.equal((await call(f,'alice','/trash')).data.items.length,1);
    drive.remove('alice',conflict.id);
    const restored=await call(f,'alice',`/trash/${id}/restore`,'POST',{});assert.equal(restored.status,200);assert.equal(restored.data.restored.id,'file-a');assert.equal(drive.get('alice','file-a').contentId,f.sharedId);
    assert.equal((await call(f,'alice',`/trash/${id}/restore`,'POST',{})).status,404);assert.equal(f.remoteCalls,0);f.repository.assertIntegrity();
});
test('目录回收站逐层浏览，只还原整项；缺失父目录和重名保持原快照，挂载可还原',async t=>{
    t.mock.method(console,'info',()=>{});const f=await createFixture();t.after(()=>f.close());const drive=f.api.spaces.get('');drive.createDirectory('alice','资料/同名/下层',20);drive.createDirectory('bob','backup',20);
    const invite=await call(f,'bob','/collaborations/invitations','POST',{kind:'directory',path:'backup'});await call(f,'alice','/collaborations/join','POST',{token:invite.data.url.split('/').at(-1)});
    const mount=await call(f,'alice','/mounts','POST',{parentPath:'资料/同名',name:'入口',collaborationId:invite.data.collaboration.id});assert.equal(mount.status,201);
    const result=await done(f,'alice',await call(f,'alice','/directories?path='+encodeURIComponent('资料/同名')+'&recursive=true','DELETE'));assert.equal(result.data.status,'completed');
    const id=(await call(f,'alice','/trash')).data.items[0].id;
    const tree=await call(f,'alice',`/trash/${id}?path=`+encodeURIComponent('资料/同名'));assert.equal(tree.data.folders[0].name,'下层');assert.equal(tree.data.files[0].id,'file-a');
    assert.equal((await call(f,'alice',`/trash/${id}?path=backup`)).data.error,'TRASH_PATH_INVALID');
    drive.removeDirectory('alice','资料',true);
    assert.equal((await call(f,'alice',`/trash/${id}/restore`,'POST',{})).data.error,'TRASH_PARENT_MISSING');
    const obstruction=drive.putMetadataObject({id:'alice'},'','资料','text/plain',{},20);
    const parentConflict=await call(f,'alice',`/trash/${id}/restore`,'POST',{});assert.equal(parentConflict.data.errorDetails.reason,'PATH_BLOCKED_BY_FILE');assert.match(parentConflict.data.userMessage,/资料.*同名文件/);drive.remove('alice',obstruction.id);
    drive.createDirectory('alice','资料',20);const restored=await call(f,'alice',`/trash/${id}/restore`,'POST',{});assert.equal(restored.status,200);assert.equal(restored.data.restored.parentPath,'资料');
    assert.ok(drive.getDirectory('alice','资料/同名/下层'));assert.equal((await call(f,'alice','/mounts')).data.mounts.some(item=>item.id===mount.data.mount.id),true);f.repository.assertIntegrity();
});
test('永久删除回收站项目才释放逻辑引用，仍有其它引用的正文保留',async t=>{
    t.mock.method(console,'info',()=>{});const f=await createFixture();t.after(()=>f.close());f.api.spaces.get('').createDirectory('alice','资料/同名',20);
    await done(f,'alice',await call(f,'alice','/files/file-a','DELETE'));const id=(await call(f,'alice','/trash')).data.items[0].id;
    assert.equal((await call(f,'alice',`/trash/${id}`,'DELETE')).status,422);
    assert.equal((await call(f,'alice',`/trash/${id}?permanent=true`,'DELETE')).status,200);assert.equal(f.repository.load('files').some(file=>file.id==='file-a'),false);assert.equal(f.content.resolve(f.sharedId).state,'READY');assert.ok(f.api.spaces.get('').get('bob','file-b'));f.repository.assertIntegrity();
});
test('网盘导入计划去除父子重复选择，保留路径，预检大小与同名冲突',async()=>{
    const window={};vm.runInNewContext(read('client/disk-import-picker.js'),{window,Map,Set,Number,Error});const calls=[];
    const file={id:'f',name:'中文.m4a',folderPath:'父/资源',size:10,type:'audio/mp4'};
    const client={raw:async(url,options)=>{calls.push({url,options});return {directories:[{path:'父/资源'},{path:'父/资源/空目录'}],files:[file]};}};
    const items=await window.DiskImportPicker._test.plan(client,'中文分区',[{kind:'directory',path:'父/资源',name:'资源'},{...file,kind:'file'}]);
    assert.deepEqual(Array.from(items,item=>item.path),['资源/','资源/空目录/','资源/中文.m4a']);assert.equal(calls.length,1);assert.equal(calls[0].options.diskSpace,'中文分区');
    await assert.rejects(window.DiskImportPicker._test.plan(client,'',[{kind:'file',id:'big',name:'big.mp4',size:101*1024*1024}]),/100MB/);
    await assert.rejects(window.DiskImportPicker._test.plan(client,'',[{kind:'file',id:'a',name:'a.txt',size:1},{kind:'file',id:'b',name:'a.txt',size:1}]),/同名/);
});

test('协同同项目、目录越界、只读权限与静态保护返回不同具体原因',async t=>{
    t.mock.method(console,'info',()=>{});const f=await createFixture();t.after(()=>f.close());const drive=f.api.spaces.get('');
    drive.createDirectory('bob','backup',20);drive.createDirectory('bob','目标',20);drive.createDirectory('alice','资料/同名',20);
    const ids=[];for(const path of ['backup','目标']){const invitation=await call(f,'bob','/collaborations/invitations','POST',{kind:'directory',path});await call(f,'alice','/collaborations/join','POST',{token:invitation.data.url.split('/').at(-1)});ids.push(invitation.data.collaboration.id);}
    const source={kind:'collaboration',collaborationId:ids[0],selection:{kind:'file',id:'file-b'}};
    const same=await call(f,'alice','/cross-scope/copy','POST',{mode:'copy',source,target:{kind:'collaboration',collaborationId:ids[0],destinationPath:'backup'}});
    assert.equal(same.data.errorDetails.reason,'SAME_COLLABORATION');assert.match(same.data.userMessage,/同一个协同项目/);
    const outside=await call(f,'alice',`/collaboration-scope/${ids[0]}/list?path=`+encodeURIComponent('目标'));
    assert.equal(outside.data.errorDetails.reason,'PATH_OUTSIDE_GRANT');assert.match(outside.data.userMessage,/所选路径/);
    await call(f,'bob',`/collaborations/${ids[1]}/members/alice`,'PATCH',{role:'viewer'});
    const viewer=await call(f,'alice','/cross-scope/copy','POST',{mode:'copy',source,target:{kind:'collaboration',collaborationId:ids[1],destinationPath:'目标'}});
    assert.equal(viewer.data.errorDetails.reason,'TARGET_READ_ONLY');assert.match(viewer.data.userMessage,/查看权限/);
    const link=await call(f,'alice','/static-resources/settings','POST',{item:{kind:'directory',path:'资料'},preset:'day'});assert.equal(link.status,201);
    const blocked=await call(f,'alice','/files/file-a','DELETE');assert.equal(blocked.data.error,'STATIC_RESOURCE_ACTIVE');assert.equal(blocked.data.errorDetails.reason,'STATIC_FILE_OPEN');assert.match(blocked.data.userMessage,/资料\/同名\/相同.har/);
    assert.ok(drive.get('alice','file-a'));assert.equal((await call(f,'alice','/trash')).data.items.length,0);
});

test('回收站独立连接读取、同时还原及分区删除保护保持数据一致',async t=>{
    t.mock.method(console,'info',()=>{});const f=await createFixture();t.after(()=>f.close());
    const space='相册&照片',suffix='?disk_space='+encodeURIComponent(space);
    const drive=f.api.spaces.get(space);drive.createDirectory('alice','日本語 & 测试/留档',20);
    await done(f,'alice',await call(f,'alice','/files/file-photo'+suffix,'DELETE'),suffix);
    const id=(await call(f,'alice','/trash'+suffix)).data.items[0].id;
    const {DatabaseSync}=require('node:sqlite');const independent=new DatabaseSync(f.repository.filename,{readOnly:true});
    try{assert.equal(independent.prepare('SELECT id FROM disk_trash_items WHERE scope=?').get(space).id,id);assert.equal(JSON.parse(independent.prepare('SELECT payload FROM disk_files WHERE scope=? AND id=?').get(space,'file-photo').payload).trashId,id);}finally{independent.close();}
    const partition=(await call(f,'alice','/spaces')).data.spaces.find(item=>item.scopeKey===space);
    const removal=await call(f,'alice','/spaces/'+partition.id,'DELETE',{confirm:true});assert.equal(removal.data.error,'DISK_SPACE_TRASH_NOT_EMPTY');
    const results=await Promise.all([call(f,'alice',`/trash/${id}/restore`+suffix,'POST',{}),call(f,'alice',`/trash/${id}/restore`+suffix,'POST',{})]);
    assert.deepEqual(results.map(result=>result.status).sort(),[200,404]);assert.equal(drive.list('alice','日本語 & 测试/留档').files.length,1);f.repository.assertIntegrity();
});

test('复制完整静态链接兼容父作用域、个体优先、过期撤销与异步切换分区',async()=>{
    const source=read('client/disk-ui.js'),copied=[];let space='';
    const ctx=vm.createContext({window:{DiskClient:{getSpace:()=>space}},location:{origin:'https://example.test'},Date,encodeURIComponent,
        telegramDriveStaticLinks:[],telegramDriveSpaceOwner:'alice',navigator:{clipboard:{writeText:async value=>copied.push(value)}},showAppToast(){},refreshTelegramDriveStaticLinks:async()=>{}});
    vm.runInContext(source.slice(source.indexOf('function telegramDriveStaticUrl('),source.indexOf('async function refreshTelegramDriveStaticLinks('))+source.slice(source.indexOf('async function copyTelegramDriveStaticLink('),source.indexOf('async function showTelegramDriveTrash(')),ctx);
    const file={kind:'file',id:'f',folderPath:'资源/日本語',name:'图 & 1.png'},link={token:'parent',files:[],directories:['资源'],expiresAt:0};ctx.telegramDriveStaticLinks=[link];
    await ctx.copyTelegramDriveStaticLink(file);assert.equal(copied[0],'https://example.test/s3pub/parent/'+['资源','日本語','图 & 1.png'].map(encodeURIComponent).join('/'));
    await ctx.copyTelegramDriveStaticLink({kind:'directory',path:'资源/日本語'});assert.ok(copied[1].endsWith('/'));
    ctx.telegramDriveStaticLinks.push({token:'self',files:['f'],directories:[],expiresAt:0});await ctx.copyTelegramDriveStaticLink(file);assert.match(copied[2],/\/self\//);
    ctx.telegramDriveStaticLinks=[{...link,expiresAt:Date.now()-1},{...link,revokedAt:Date.now()}];await assert.rejects(ctx.copyTelegramDriveStaticLink(file),/过期/);
    ctx.telegramDriveStaticLinks=[link];ctx.refreshTelegramDriveStaticLinks=async()=>{space='切换后';};await assert.rejects(ctx.copyTelegramDriveStaticLink(file),/分区或账号已切换/);assert.equal(copied.length,3);
});

test('网盘导入取消沿请求 signal 传递，不返回部分文件；异常大小在读取前拦截',async()=>{
    class Node {constructor(tag){this.tag=tag;this.children=[];this.style={};}append(...nodes){this.children.push(...nodes);}replaceChildren(){this.children=[];}setAttribute(){}addEventListener(){}showModal(){}close(){}remove(){}}
    const body=new Node('body'),window={DiskErrorMessages:messages},file={kind:'file',id:'f',name:'未完成.txt',size:10};let cancelled=false,fetchStarted;
    const started=new Promise(resolve=>fetchStarted=resolve);
    window.DiskClient={getSpace:()=>'',raw:async path=>path==='/spaces'?{spaces:[{name:'默认分区',scopeKey:''}]}:{files:[file]}};
    vm.runInNewContext(read('client/disk-import-picker.js'),{window,document:{body,createElement:tag=>new Node(tag),addEventListener(){},removeEventListener(){}},AbortController,Uint8Array,Map,Set,Number,Error,
        fetch:async(_url,{signal})=>{fetchStarted();return{ok:true,body:{getReader:()=>({read:()=>new Promise((_resolve,reject)=>signal.aborted ? (cancelled=true,reject(signal.reason)) : signal.addEventListener('abort',()=>{cancelled=true;reject(signal.reason);})),cancel(){}})}};}});
    const chosen=window.DiskImportPicker.choose();for(let i=0;i<6;i++)await Promise.resolve();
    const dialog=body.children.at(-1),tree=dialog.children[1],footer=dialog.children[3];assert.equal(tree.children.length,1);
    const check=tree.children[0].children[0];check.checked=true;check.onchange();const running=footer.children[1].onclick();await started;
    footer.children[0].onclick();assert.equal(await chosen,null);await running;assert.equal(cancelled,true);
    await assert.rejects(window.DiskImportPicker._test.plan(window.DiskClient,'',[{...file,size:-1}]),/大小信息无效/);
});

test('schema 3 升级回收站前备份完整数据库，不修改已有文件与内容引用',t=>{
    const os=require('node:os'),{DatabaseSync}=require('node:sqlite'),{openDiskRepository}=require('../server/disk-repository');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'disk-trash-migration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const first=openDiskRepository(dir);first.replace('files',[{id:'old-file',ownerId:'alice',name:'旧资料',size:0,type:'text/plain',folderPath:'',parts:[]}],file=>file.id);first.checkpoint();first.close();
    const legacy=new DatabaseSync(path.join(dir,'disk.sqlite'));legacy.exec('DELETE FROM disk_schema_migrations WHERE version=4; DROP TABLE disk_trash_items');legacy.close();
    const upgraded=openDiskRepository(dir);try{assert.equal(upgraded.load('files')[0].name,'旧资料');assert.deepEqual(upgraded.load('trash_items'),[]);upgraded.assertIntegrity();
        const backup=fs.readdirSync(dir).find(name=>name.startsWith('disk-before-trash-'));assert.ok(backup);const saved=new DatabaseSync(path.join(dir,backup),{readOnly:true});try{assert.equal(saved.prepare('SELECT MAX(version) AS version FROM disk_schema_migrations').get().version,3);assert.equal(saved.prepare('SELECT name FROM disk_files WHERE id=?').get('old-file').name,'旧资料');}finally{saved.close();}
    }finally{upgraded.close();}
});
