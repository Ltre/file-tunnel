'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {createDiskPartCache,diskPartCacheKey}=require('../server/disk-part-cache');
const {createFixture}=require('./support/disk-content-admin-fixture.cjs');
const {DatabaseSync}=require('node:sqlite');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function collect(stream){const chunks=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);}

test('已有同尺寸错误缓存须校验并只重拉该缓存；有效缓存继续复用',async t=>{
    const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'editor-cache-integrity-'));
    t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
    const cache=createDiskPartCache({dataDir}),body=Buffer.from('verified-body');let calls=0;
    const options={key:'one',size:body.length,expectedSha256:hash(body),source:async()=>{calls++;return Readable.from([body]);}};
    assert.deepEqual(await collect(await cache.open(options)),body);
    fs.writeFileSync(path.join(dataDir,'telegram-part-cache',hash('one')+'.part'),Buffer.alloc(body.length,0));
    assert.deepEqual(await collect(await cache.open(options)),body);assert.equal(calls,2);
    assert.deepEqual(await collect(await cache.open(options)),body);assert.equal(calls,2);
});

test('内容和物理版本隔离，两个逻辑引用仍共享同一 Content 缓存键',()=>{
    const part={fileId:'same-remote-id',size:10},a={contentId:'content-a',physicalRevision:1},b={...a,id:'another-logical-file'};
    assert.equal(diskPartCacheKey('backend',a,part,0,9),diskPartCacheKey('backend',b,part,0,9));
    assert.notEqual(diskPartCacheKey('backend',a,part,0,9),diskPartCacheKey('backend',{contentId:'content-b',physicalRevision:1},part,0,9));
    assert.notEqual(diskPartCacheKey('backend',a,part,0,9),diskPartCacheKey('backend',{...a,physicalRevision:2},part,0,9));
    assert.equal(diskPartCacheKey('backend',{},part,0,9),'v2:backend:same-remote-id:10::0:9');
});

test('编辑追加 AA 后立即读取新正文；污染缓存自动恢复且旧共享引用不受影响',async t=>{
    const original=Buffer.from('shared-fixture'),remoteBodies=new Map([['fixture-file-101',original]]);let reads=0,nextMessage=7000;
    const f=await createFixture({telegram:{
        parts:file=>file.parts,
        readPart:async(_backend,part,{start,end})=>{reads++;const body=remoteBodies.get(part.fileId);assert.ok(body,'必须读取已确认的新分片');return Readable.from([body.subarray(start,end+1)]);},
        upload:async(_backend,files)=>files.map(file=>{const body=fs.readFileSync(file.path),messageId=nextMessage++,fileId='edited-'+messageId;remoteBodies.set(fileId,body);
            // Mirror real repair uploads: returned parts have no per-part SHA.
            return {fileId,messageId,size:body.length,parts:[{fileId,messageId,offset:0,size:body.length}]};})
    }});
    t.after(async()=>{
        // Content-Length completion in Fetch can precede the server stream's
        // close/release event. Do not delete SQLite while that reader still runs.
        const db=new DatabaseSync(f.repository.filename,{readOnly:true});
        try {for(let i=0;i<200;i++){
            const {count}=db.prepare("SELECT COUNT(*) AS count FROM disk_content_leases WHERE kind='read' AND upload_id!='fixture-reader'").get();
            if(!count)break;if(i===199)throw new Error('测试读取租约未释放');await new Promise(r=>setTimeout(r,5));
        }}finally{db.close();await f.close();}
    });const drive=f.api.spaces.get('');
    drive.createDirectory('alice','资料/同名',30);
    const initial=drive.get('alice','file-a'),oldVersion=initial.logicalContentVersion;
    const twin=drive.putCopiedObject(f.auth.user('alice'),'','original-copy.png',initial,initial.parts,{channelId:initial.channelId},30);
    const request=async(route,options={})=>fetch(f.base+'/api/telegram/drive'+route,{...options,headers:{'X-Test-User':'alice',...options.headers}});
    const read=async id=>{const response=await request('/files/'+id+'/stream');assert.equal(response.status,200);return Buffer.from(await response.arrayBuffer());};
    assert.deepEqual(await read(initial.id),original);const priorReads=reads;
    const edited=Buffer.concat([original,Buffer.from([0xaa])]);
    const response=await request('/files/'+initial.id+'/content',{method:'PUT',headers:{'X-Disk-File-Size':String(edited.length),'X-Disk-Expected-Version':String(initial.logicalContentVersion),'X-Disk-File-Type':'image/png'},body:edited});
    assert.equal(response.status,202);const accepted=await response.json();let job;
    for(let i=0;i<150;i++){job=await (await request('/operations/'+accepted.operation_id)).json();if(['completed','failed'].includes(job.status))break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(job.status,'completed',JSON.stringify(job));
    const current=drive.get('alice',initial.id);
    assert.notEqual(current.contentId,twin.contentId);assert.equal(current.logicalContentVersion,oldVersion+1);
    assert.deepEqual(await read(current.id),edited);assert.equal(reads,priorReads+1);
    assert.deepEqual(await read(twin.id),original);assert.equal(reads,priorReads+1,'旧引用继续命中原有效缓存');
    const backendKey=hash('https://example.test\0fixture-only'),part=current.parts[0];
    const key=diskPartCacheKey(backendKey,current,part,0,edited.length-1),filename=path.join(f.dataDir,'telegram-part-cache',hash(key)+'.part');
    assert.ok(fs.existsSync(filename));fs.writeFileSync(filename,Buffer.alloc(edited.length,0));
    assert.deepEqual(await read(current.id),edited,'没有 part.sha256 时使用已验证的整文件哈希');assert.equal(reads,priorReads+2);
    assert.deepEqual(await read(twin.id),original);assert.equal(reads,priorReads+2);
    f.repository.assertIntegrity();
});
