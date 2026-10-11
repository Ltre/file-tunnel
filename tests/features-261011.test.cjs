'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createFixture}=require('./support/disk-content-admin-fixture.cjs');
const {createS3Gateway}=require('../server/s3');
const {probe}=require('../tools/diagnose-s3-foldersync.cjs');
function model(){const window={};vm.runInNewContext(fs.readFileSync('client/disk-file-editor.js','utf8'),{window,Blob,Uint8Array,TextEncoder,TextDecoder});return window.DiskFileEditor._test;}
test('分页模型保留跨段 UTF-8/BOM/CRLF；窗口大小有界，保存仍为完整文件',async()=>{
    const {Document,validUtf8,PAGE,textBlob,rawIndex,difference}=model(),body='\uFEFF'+('中😀文\r\n'.repeat(30000)),doc=new Document(textBlob(body));await validUtf8(doc.blob);
    const first=await doc.window(0);assert.ok(first.raw.startsWith('\uFEFF'));assert.ok(first.end-first.start<=PAGE+4);
    const page=await doc.window(PAGE+1);assert.ok(page.raw.length<PAGE);assert.ok(!page.raw.includes('�'));assert.equal((await doc.window(doc.blob.size)).text,'');
    const full=async()=>new TextDecoder('utf-8',{ignoreBOM:true}).decode(await doc.blob.arrayBuffer());
    const end=doc.blob.size;doc.replace(end,end,textBlob('尾部修改'));assert.equal(await full(),body+'尾部修改');
    doc.history();assert.equal(await full(),body);doc.history(true);assert.equal(await full(),body+'尾部修改');
    assert.equal(rawIndex('a\r\nb',2),3);const diff=difference('a😀b','a😃b');assert.equal('a😀b'.slice(0,diff.start)+'a😃b'.slice(diff.start,diff.right)+'a😀b'.slice(diff.left),'a😃b');
});
test('大段粘贴不丢失未显示正文；十六进制及撤销历史保持有界',async()=>{
    const {Document,textBlob,bytesFromHex,HEX_PAGE,validUtf8}=model();const doc=new Document(new Blob([new Uint8Array(2_000_000)]));
    const inserted='粘贴😀'.repeat(100000),at=1_900_000;doc.replace(at,at,textBlob(inserted));assert.equal(doc.blob.size,2_000_000+Buffer.byteLength(inserted));
    assert.equal(await doc.blob.slice(at,at+Buffer.byteLength(inserted)).text(),inserted);assert.equal((await doc.window(0,true)).end,HEX_PAGE);
    for(let i=0;i<80;i++)doc.replace(0,1,new Blob([bytesFromHex('FF')]));assert.ok(doc.undoStack.length<=50);
    await assert.rejects(validUtf8(new Blob([Uint8Array.from([0xff,0x80])])));assert.throws(()=>doc.replace(0,0,new Blob([new Uint8Array(20_000_000)])),/20MB/);
});
test('实际编辑控制器跨段修改、复制粘贴、撤销重做后提交完整 Blob 与原版本',async()=>{
    class Node {constructor(tag){this.tagName=tag;this.children=[];this.value='';this.style={setProperty(){}};this.classList={toggle(){}};}append(...v){this.children.push(...v);}add(v){this.children.push(v);}setAttribute(){}addEventListener(){}removeEventListener(){}closest(){return null;}setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}}
    const original='BEGIN\r\n'+'x'.repeat(210000)+'\r\nEND',source=new Blob([original]),saved=[],clipboard=[];
    source.arrayBuffer=()=>{throw new Error('不应整份转成 ArrayBuffer');};
    const window={addEventListener(){},removeEventListener(){},DiskClient:{context:()=>({diskSpace:'中文分区'}),read:async()=>source,raw:async(route,options)=>{saved.push({route,options});return {ok:true};}}};
    const context={window,innerHeight:700,Blob,Uint8Array,TextEncoder,TextDecoder,document:{createElement:tag=>new Node(tag)},Option:class{constructor(text,value){this.text=text;this.value=value;}},setTimeout,clearTimeout,navigator:{clipboard:{writeText:async text=>clipboard.push(text)}}};
    vm.runInNewContext(fs.readFileSync('client/disk-file-editor.js','utf8'),context);
    await window.DiskFileEditor.open({item:{id:'logical-1',name:'test.txt',size:source.size,logicalContentVersion:6},openDialog:async options=>{
        const body=options.body,toolbar=body.children.find(n=>n.className==='disk-editor-navigation'),panes=body.children.find(n=>n.className==='disk-editor-panes'),edit=panes.children[0],offset=toolbar.children.find(n=>n.tagName==='input');
        const click=async name=>toolbar.children.find(n=>n.textContent===name).onclick();
        assert.equal(edit.value.length,102399); // 100KiB source, with one CRLF normalized for textarea.
        edit.value=edit.value.replace('BEGIN','START');edit.oninput();
        edit.setSelectionRange(0,0);await click('记住选区起点');offset.value='8000';await click('定位');edit.setSelectionRange(0,0);await click('复制到此光标');assert.ok(clipboard[0].startsWith('START\r\n'));
        offset.value=String(source.size-10);await click('定位');edit.setSelectionRange(edit.value.length,edit.value.length);
        const paste='中文😀'.repeat(10000);edit.onpaste({preventDefault(){},clipboardData:{getData:()=>paste}});for(let i=0;i<30&&edit.disabled;i++)await new Promise(r=>setImmediate(r));
        await click('撤销');await click('重做');await options.validate();
        assert.equal(new TextDecoder('utf-8',{ignoreBOM:true}).decode(await saved[0].options.body.arrayBuffer()),original.replace('BEGIN','START')+paste);
        assert.equal(saved[0].options.headers['X-Disk-Expected-Version'],'6');assert.equal(saved[0].options.diskSpace,'中文分区');return null;
    }});
});
async function fixture(t){const f=await createFixture();t.after(()=>f.close());const call=async(route,body,user='alice',method=body?'POST':'GET')=>{
    const response=await fetch(f.base+'/api/telegram/drive'+route,{method,headers:{'X-Test-User':user,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;};return {f,call,drive:f.api.spaces.get('')};}
test('目录标记仅显式生效且按分区隔离；来源改名不覆盖挂载别名',async t=>{
    const {call,drive}=await fixture(t);drive.createDirectory('alice','mark/child',30);drive.createDirectory('bob','backup/a',30);
    const own=await call('/collaborations/invitations',{kind:'directory',path:'mark'});assert.ok(own);
    await call('/static-resources',{items:[{kind:'directory',path:'mark'}],preset:'day'});
    const dirs=(await call('/directories')).directories;assert.equal(dirs.find(d=>d.path==='mark').collaborationOwned,true);assert.equal(dirs.find(d=>d.path==='mark').staticExplicit,true);assert.equal(dirs.find(d=>d.path==='mark/child').staticExplicit,false);
    const other=(await call('/directories?disk_space='+encodeURIComponent('相册&照片'))).directories;assert.ok(!other.some(d=>d.path==='mark'));
    const invite=await call('/collaborations/invitations',{kind:'directory',path:'backup'},'bob');await call('/collaborations/join',{token:invite.url.split('/').at(-1)});
    const {mount}=await call('/mounts',{parentPath:'',name:'我的别名',collaborationId:invite.collaboration.id});
    const moved=await call('/directories',{path:'backup',destinationPath:'',name:'改名来源'},'bob','PATCH');if(moved.operation_id){for(let i=0;i<100;i++){const job=await call('/operations/'+moved.operation_id,null,'bob');if(job.status==='completed')break;if(job.status==='failed')throw new Error(job.errorCode);await new Promise(r=>setTimeout(r,10));}}
    const refreshed=(await call('/mounts')).mounts.find(m=>m.id===mount.id);assert.equal(refreshed.name,'我的别名');assert.equal(refreshed.sourceName,'改名来源');assert.equal(refreshed.lastKnownTitle,'backup');
    await call('/collaborations/'+invite.collaboration.id+'/leave',{});const stale=(await call('/mounts')).mounts.find(m=>m.id===mount.id);assert.equal(stale.status,'inaccessible');assert.equal(stale.sourceName,'backup');
});
test('跨协同复制明细持久保留操作时路径；重复请求不新增副本或记录',async t=>{
    const {f,call,drive}=await fixture(t);drive.createDirectory('bob','backup/目标',30);
    const invite=await call('/collaborations/invitations',{kind:'directory',path:'backup'},'bob');await call('/collaborations/join',{token:invite.url.split('/').at(-1)});
    const input={mode:'copy',requestId:'stable-copy-request',source:{kind:'native',selection:{kind:'file',id:'file-a'}},target:{kind:'collaboration',collaborationId:invite.collaboration.id,destinationPath:'backup/目标'}};
    const result=await call('/cross-scope/copy',input);const repeated=await call('/cross-scope/copy',input);assert.deepEqual(repeated,result);
    const jobs=(await call('/operations')).operations.filter(job=>job.requestId===input.requestId);assert.equal(jobs.length,1);assert.equal(jobs[0].status,'completed');
    assert.equal(jobs[0].transferDetails.source.entries[0].path,'/资料/同名/相同.har');assert.equal(jobs[0].transferDetails.target.directory,'/目标');
    drive.update('alice','file-a',{name:'源后来改名.har'});const stored=(await call('/operations')).operations.find(job=>job.requestId===input.requestId);assert.equal(stored.transferDetails.source.entries[0].name,'相同.har');
    assert.equal(drive.list('bob','backup/目标').files.length,1);f.repository.assertIntegrity();
});
test('FolderSync 探针验证 Bucket/XML/目录 marker；默认不写入且报告不泄露凭据',async t=>{
    const {f}=await fixture(t),gateway=createS3Gateway({dataDir:f.dataDir,objectStorage:f.api.objectStorage});
    const express=require('express'),app=express();app.use('/S3API',gateway.api);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
    const credential=gateway.credentials.create({userId:'alice',bucketMappings:[{bucket:'probe-bucket',diskSpace:''}]});const endpoint='http://127.0.0.1:'+server.address().port+'/S3API';
    const report=await probe({endpoint,bucket:'probe-bucket',credential});assert.ok(report.results.every(r=>r.status===200));assert.match(report.results.find(r=>r.stage==='buckets').body,/<Name>probe-bucket<\/Name>/);assert.ok(!JSON.stringify(report).includes(credential.secretAccessKey));
    const write=await probe({endpoint,bucket:'probe-bucket',credential,write:true});assert.equal(write.results.find(r=>r.stage==='create-empty-directory').status,200);assert.equal(write.results.find(r=>r.stage==='remove-probe-directory').status,204);
    const duplicate=await probe({endpoint:endpoint+'/probe-bucket',bucket:'probe-bucket',credential});assert.equal(duplicate.results.find(r=>r.stage==='objects-v2').status,404);assert.match(duplicate.results.find(r=>r.stage==='objects-v2').body,/<Error><Code>NoSuchKey/);
});
test('挂载内部移动明细归操作人，来源所有者不获得对方网盘操作详情',async t=>{
    const {call,drive}=await fixture(t);drive.createDirectory('bob','backup/a',30);
    const invite=await call('/collaborations/invitations',{kind:'directory',path:'backup'},'bob');await call('/collaborations/join',{token:invite.url.split('/').at(-1)});
    const {mount}=await call('/mounts',{parentPath:'',name:'本地别名',collaborationId:invite.collaboration.id});
    const response=await call('/mount-scope/'+mount.id+'/files/file-b',{folderPath:'backup/a'},'alice','PATCH');
    for(let i=0;i<100;i++){const job=await call('/mount-scope/'+mount.id+'/operations/'+response.operation_id);if(job.status==='completed')break;if(job.status==='failed')throw new Error(job.errorCode);await new Promise(r=>setTimeout(r,10));}
    assert.ok(!(await call('/operations')).operations.some(job=>job.type==='transfer-history'));
    const personal=(await call('/mount-scope/'+mount.id+'/operations')).operations.find(job=>job.type==='transfer-history');assert.equal(personal.status,'completed');assert.equal(personal.transferDetails.source.entries[0].path,'/相同.har');assert.equal(personal.transferDetails.target.directory,'/a');
    assert.ok(!(await call('/operations',null,'bob')).operations.some(job=>job.operation_id===response.operation_id));
    const sourceJob=await call('/operations/'+response.operation_id,null,'bob');assert.equal(sourceJob.transferDetails,undefined);
    const scoped=(await call('/mount-scope/'+mount.id+'/operations')).operations;assert.ok(scoped.some(job=>job.operation_id===personal.operation_id));
});
test('复制完成但删源受保护时记录部分结果；安全重试仍只有一条明细',async t=>{
    const {call,drive}=await fixture(t);drive.createDirectory('alice','目标',30);
    const invite=await call('/collaborations/invitations',{kind:'directory',path:'backup'},'bob');await call('/collaborations/join',{token:invite.url.split('/').at(-1)});
    const input={mode:'move',requestId:'partial-move-request',source:{kind:'collaboration',collaborationId:invite.collaboration.id,selection:{kind:'directory',path:'backup'}},target:{kind:'native',destinationPath:'目标'}};
    const first=await call('/cross-scope/move',input);assert.equal(first.state,'COPIED_SOURCE_RETAINED');const second=await call('/cross-scope/move',input);assert.equal(second.copied[0].id,first.copied[0].id);
    assert.ok(!(await call('/operations')).operations.some(job=>job.requestId===input.requestId));
    const jobs=(await call('/collaboration-scope/'+invite.collaboration.id+'/operations')).operations.filter(job=>job.requestId===input.requestId);assert.equal(jobs.length,1);assert.equal(jobs[0].phase,'source-retained');assert.equal(jobs[0].transferDetails.mode,'move');assert.equal(jobs[0].message,'已复制，来源仍保留');
});

test('跨分区同时选择父目录和内部文件时明细只列实际复制的根项',async t=>{
    const {call,drive}=await fixture(t);drive.createDirectory('alice','资料',30);
    const {partition}=await call('/spaces',{name:'结果分区'});
    await call('/spaces/transfer',{mode:'copy',targetSpace:partition.id,requestId:'nested-selection-request',items:[{kind:'directory',path:'资料'},{kind:'file',id:'file-a'}]});
    const job=(await call('/operations')).operations.find(job=>job.requestId==='nested-selection-request');
    assert.deepEqual(job.transferDetails.source.entries,[{kind:'directory',name:'资料',path:'/资料'}]);
});

test('单文件协同来源改名即时读取实际文件名，不依赖旧授权名称',async t=>{
    const {call,drive}=await fixture(t);drive.createDirectory('bob','backup',30);
    const invite=await call('/collaborations/invitations',{kind:'file',fileId:'file-b'},'bob');
    await call('/collaborations/join',{token:invite.url.split('/').at(-1)});
    const {mount}=await call('/mounts',{parentPath:'',name:'本地文件别名',collaborationId:invite.collaboration.id});
    const response=await call('/files/file-b',{name:'实际新文件名.har'},'bob','PATCH');
    for(let i=0;i<100;i++){const job=await call('/operations/'+response.operation_id,null,'bob');if(job.status==='completed')break;if(job.status==='failed')throw new Error(job.errorCode);await new Promise(r=>setTimeout(r,10));}
    const result=(await call('/mounts')).mounts.find(item=>item.id===mount.id);
    assert.equal(result.sourceName,'实际新文件名.har');assert.equal(result.name,'本地文件别名');
    await call('/collaborations/'+invite.collaboration.id+'/leave',{});
    assert.equal((await call('/mounts')).mounts.find(item=>item.id===mount.id).sourceName,'相同.har');
});
