'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { openDiskRepository } = require('../server/disk-repository');
const { createContentProof, prefix } = require('../server/disk-content-proof');
const { Sha256 } = require('../client/disk-content-hash-worker');
const {createDiskAuth}=require('../server/disk-auth');
const {createTelegramChatDictionary}=require('../server/telegram-chat-dictionary');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-object-'));
    const repository = openDiskRepository(dir), content = repository.content;
    t.after(() => { repository.close(); fs.rmSync(dir, { recursive:true, force:true }); });
    const files = [];
    const save = file => { files.push(file); repository.replace('files', files, item => item.id); return file; };
    const remove = id => { files.splice(files.findIndex(file => file.id === id), 1); repository.replace('files', files, item => item.id); };
    const file = (id, ownerId, bytes, messageId) => ({ id, ownerId, folderPath:'', name:id+'.bin', size:bytes.length,
        type:'application/octet-stream', channelId:'-100', backendId:'bot', contentSha256:digest(bytes),
        parts:bytes.length ? [{ offset:0, size:bytes.length, fileId:'remote-'+messageId, messageId, messageDate:Date.now() }] : [] });
    return { repository, content, save, remove, file, files, dir };
}
test('浏览器增量 SHA-256 与服务端一致，含跨块和大文件边界', () => {
    for (const size of [0,1,55,56,63,64,65,1024,2_000_003]) {
        const bytes=crypto.randomBytes(size), sha=new Sha256();
        for(let i=0;i<size;i+=173)sha.update(bytes.subarray(i,i+173));
        assert.equal(sha.digest(),digest(bytes));
    }
});

test('外部应用停用后，旧 token 的在途 Content 附着在同一 SQL 事务中被拒绝',async t=>{
    const f=fixture(t),auth=createDiskAuth({dataDir:f.dir}),secret='test-content-app-secret';
    await auth.saveApp({app_id:'content-test',app_secret:secret});
    const verified=await auth.authenticateApp('content-test',secret);
    const issued=auth.issueToken(verified,{token:'test-bot',channelId:'-100',baseUrl:'https://example.test'});
    const proof=createContentProof({content:f.content,validate:async()=>true,open:async()=>Readable.from([])});
    const req={headers:{authorization:'Bearer '+issued.access_token},diskApp:auth.access(issued.access_token),diskUser:{id:'alice'},diskScope:{diskSpace:''}};
    const authorization=proof.authorization(req);
    proof.assertAuthorization(authorization);
    await auth.saveApp({app_id:'content-test',enabled:false});
    assert.throws(()=>f.save({...f.file('new','alice',Buffer.from('abc'),200),contentAuthorization:authorization}),/ACCESS_TOKEN_INVALID/);
    assert.equal(f.repository.load('files').length,0);
    assert.equal(f.content.withDatabase(db=>db.prepare('SELECT count(*) AS n FROM disk_content_refs').get().n),0);
});
test('共享引用不继承权限，删除最后一个引用才清理；read lease 与 GC fencing', t => {
    const f=fixture(t), bytes=Buffer.from('shared bytes');
    const a=f.save(f.file('a','alice',bytes,1)), b=f.save(f.file('b','bob',bytes,2));
    assert.equal(a.contentId,b.contentId);
    assert.equal(f.content.references(a.contentId).length,2);
    assert.equal(f.repository.load('files')[1].ownerId,'bob');
    assert.equal(f.repository.load('files')[1].fileId,'remote-1');
    assert.equal(f.content.allowed({channelId:'-100',parts:[{messageId:1}]}),false);
    // Only the losing candidate's independent message can be collected.
    const abandoned=f.content.claimCleanup(); assert.equal(abandoned.physical.parts[0].messageId,2);
    f.content.finishCleanup(abandoned);
    const lease=f.content.lease(a.contentId,'reader','', 'read');
    f.remove('a'); assert.equal(f.content.resolve(b.contentId).state,'READY');
    f.remove('b'); assert.equal(f.content.resolve(b.contentId).state,'DELETE_PENDING');
    assert.equal(f.content.claimCleanup(Date.now()+120_000),null);
    f.content.releaseLease(lease);
    const task=f.content.claimCleanup(Date.now()+240_000);
    assert.equal(task.physical.parts[0].messageId,1);
    assert.equal(f.content.find(digest(bytes),bytes.length),null);
    assert.throws(()=>f.content.lease(a.contentId,'late',''),/CONTENT_NOT_AVAILABLE/);
    f.content.finishCleanup({...task,token:'old-worker'});
    assert.equal(f.content.resolve(a.contentId).state,'DELETING');
    f.content.finishCleanup(task); assert.equal(f.content.resolve(a.contentId).state,'DELETED');
    assert.throws(()=>f.content.verifyLegacy(a.contentId,digest(bytes),bytes.length,1),/CONTENT_WRITE_CONFLICT/,'迟到的历史验证不能重新发布已删除 generation');
});
test('最后引用删除立即停止新复用；在途 lease 可完成，新 generation 不被旧清理撤除', t => {
    const f=fixture(t), bytes=Buffer.from('delete then reupload');
    const original=f.save(f.file('original','alice',bytes,8)), id=original.contentId;
    const lease=f.content.lease(id,'alice','inflight','proof');
    f.remove('original');
    const pending=f.content.resolve(id);
    assert.equal(pending.state,'DELETE_PENDING');
    assert.equal(f.content.references(id).length,0);
    assert.equal(f.content.find(digest(bytes),bytes.length),null,'最后引用已删除，新的上传不能再次发现旧正文');
    assert.equal(f.content.claimCleanup(),null,'已有在途 lease 仍保护正文');
    assert.throws(()=>f.content.lease(id,'bob','new','proof'),/CONTENT_NOT_AVAILABLE/);
    assert.throws(()=>f.repository.replace('files',[{...original,id:'unleased'}],file=>file.id),/CONTENT_NOT_AVAILABLE/,'不能无租约复活零引用正文');

    const fresh=f.save(f.file('fresh','alice',bytes,9));
    assert.notEqual(fresh.contentId,id,'完整正文重传必须建立新 generation');
    assert.equal(f.content.find(digest(bytes),bytes.length),fresh.contentId);

    f.save({...original,id:'inflight',contentLease:lease});
    assert.equal(f.content.resolve(id).state,'READY');
    assert.equal(f.content.resolve(id).cleanup_after,0);
    assert.equal(f.content.claimCleanup(pending.cleanup_after+60_000),null,'重新附着后旧清理任务不能删除正文');
    assert.equal(f.content.references(id).length,1);
    assert.equal(f.content.find(digest(bytes),bytes.length),fresh.contentId,'旧在途附着不能覆盖新 generation 的索引');

    f.remove('inflight');
    const cleanup=f.content.claimCleanup(pending.cleanup_after+240_000,id);
    assert.equal(cleanup.content_id,id);
    f.content.finishCleanup(cleanup);
    assert.equal(f.content.resolve(id).state,'DELETED');
    assert.equal(f.content.find(digest(bytes),bytes.length),fresh.contentId,'旧清理不能撤除其它 generation 的索引');
    f.remove('fresh');
    f.content.finishCleanup(f.content.claimCleanup(Date.now()+300_000,fresh.contentId));
    assert.equal(f.content.find(digest(bytes),bytes.length),null);
});

test('删除前的在途附着可恢复索引，但异步检查期间已零引用不能签发新 proof',async t=>{
    const f=fixture(t),bytes=Buffer.from('before-delete'),a=f.save(f.file('a','alice',bytes,10));
    const lease=f.content.lease(a.contentId,'alice','before','proof');
    f.remove('a');
    f.save({...a,id:'restored',contentLease:lease});
    assert.equal(f.content.find(digest(bytes),bytes.length),a.contentId);
    const proof=createContentProof({content:f.content,validate:async()=>{f.remove('restored');return true;},open:async()=>{throw Error('不应读取已删除正文');}});
    const result=await proof.preflight({diskUser:{id:'bob'},diskScope:{diskSpace:''}},{name:'later',size:bytes.length,contentSha256:digest(bytes)},'');
    assert.deepEqual(result,{status:'miss'});
    assert.equal(f.content.withDatabase(db=>db.prepare('SELECT count(*) AS n FROM disk_content_pop_challenges').get().n),0);
    assert.equal(f.content.withDatabase(db=>db.prepare('SELECT count(*) AS n FROM disk_content_leases').get().n),0);
});

test('物理 repair 共享更新但 Logical replacement 只影响自己，旧 revision 读 lease 保持', t => {
    const f=fixture(t), bytes=Buffer.from('abc');
    const a=f.save(f.file('a','alice',bytes,10)), b=f.save(f.file('b','bob',bytes,11));
    const oldId=a.contentId, lease=f.content.lease(oldId,'reader','', 'read');
    Object.assign(a,f.file('a','alice',bytes,12),{contentPhysicalRepair:true});
    f.repository.replace('files',f.files,item=>item.id);
    assert.equal(f.repository.load('files')[1].fileId,'remote-12');
    assert.equal(f.repository.load('files')[1].logicalContentVersion,1);
    assert.equal(f.content.leasedPhysical(lease).parts[0].messageId,10);
    assert.equal(f.content.allowed({channelId:'-100',parts:[{messageId:10}]}),false);
    Object.assign(a,f.file('a','alice',Buffer.from('xyz'),13));
    f.repository.replace('files',f.files,item=>item.id);
    const result=f.repository.load('files');
    assert.notEqual(result[0].contentId,result[1].contentId);
    assert.equal(result[0].logicalContentVersion,2);
    assert.equal(result[1].contentId,oldId);
    assert.deepEqual(f.content.withDatabase(db=>db.prepare('PRAGMA foreign_key_check').all()),[]);
});
test('跨用户 PoP 不返回物理位置，一次性绑定真实 viewer 与目标；篡改失败不授权', async t => {
    const f=fixture(t), bytes=crypto.randomBytes(170_003), a=f.save(f.file('a','alice',bytes,20));
    const proof=createContentProof({content:f.content,validate:async()=>true,open:async(_candidate,start,end)=>Readable.from([bytes.subarray(start,end+1)])});
    const req={diskUser:{id:'alice'},diskViewerId:'bob',diskScope:{diskSpace:''},collaboration:{id:'grant'}};
    const file={name:'mine.dat',size:bytes.length,type:'x/test',contentSha256:digest(bytes)};
    const challenge=await proof.preflight(req,file,'');
    assert.equal(challenge.status,'proof');
    assert.equal(JSON.stringify(challenge).includes(a.contentId),false);
    assert.equal(JSON.stringify(challenge).includes('remote-'),false);
    const digests=challenge.ranges.map(range=>digest(Buffer.concat([prefix(challenge.nonce,range),bytes.subarray(range.offset,range.offset+range.size)])));
    assert.throws(()=>proof.prove({...req,diskViewerId:'mallory'},challenge.ticket,digests),/CONTENT_PROOF_EXPIRED/);
    assert.throws(()=>proof.prove({...req,headers:{authorization:'Bearer another-session'}},challenge.ticket,digests),/CONTENT_PROOF_INVALID/);
    assert.throws(()=>proof.prove({...req,collaboration:{id:'another-grant'}},challenge.ticket,digests),/CONTENT_PROOF_INVALID/);
    const verified=proof.prove(req,challenge.ticket,digests);
    assert.throws(()=>proof.consume(req,{...file,name:'different',reuseTicket:verified.reuseTicket},''),/CONTENT_PROOF_INVALID/);
    assert.equal(proof.consume(req,{...file,reuseTicket:verified.reuseTicket},'').id,a.contentId);
    assert.throws(()=>proof.consume(req,{...file,reuseTicket:verified.reuseTicket},''),/CONTENT_PROOF_INVALID/);
    const bad=await proof.preflight(req,file,'');
    assert.deepEqual(proof.prove(req,bad.ticket,bad.ranges.map(()=>digest('wrong'))),{status:'miss'});
    assert.throws(()=>proof.consume(req,{...file,reuseTicket:bad.ticket},''),/CONTENT_PROOF_INVALID/);
});
test('Content caption 只含物理排障字段；重试不重发正文且持有清理租约', t => {
    const f=fixture(t), a=f.save(f.file('a','alice',Buffer.from('caption'),40));
    const task=f.content.claimCaption();
    assert.equal(task.content_id,a.contentId);
    assert.match(task.physical.caption,/content_key: sha256:v1:/);
    assert.match(task.physical.caption,/message_id: 40/);
    assert.doesNotMatch(task.physical.caption,/user_id:|disk_space:|logical_file_id:|path:/);
    f.remove('a');
    assert.equal(f.content.claimCleanup(Date.now()+120_000),null,'caption HTTP 在途时不能清理 Anchor');
    f.content.finishCaption(task,new Error('TELEGRAM_NETWORK_ERROR'));
    const state=f.content.withDatabase(db=>db.prepare('SELECT * FROM disk_content_caption_jobs WHERE id=?').get(task.id));
    assert.equal(state.state,'PENDING'); assert.ok(state.retry_at>Date.now());
    f.content.write(db=>{
        db.prepare("UPDATE disk_contents SET state='READY',cleanup_after=0 WHERE id=?").run(a.contentId);
        db.prepare('UPDATE disk_content_caption_jobs SET retry_at=0 WHERE id=?').run(task.id);
    });
    const retry=f.content.claimCaption();assert.notEqual(retry.token,task.token);
    f.content.finishCaption(task);
    assert.equal(f.content.withDatabase(db=>db.prepare('SELECT state FROM disk_content_caption_jobs WHERE id=?').get(task.id)).state,'CLAIMED','失效 worker 不可完成新任务');
    f.content.finishCaption(retry);
    assert.equal(f.content.claimCaption(),null);
    assert.equal(f.content.resolve(a.contentId).physical.parts[0].messageId,40);
});
test('Content 写事务拒绝异步 work 并回滚，不跨 await 占用 SQLite 写锁', t=>{
    const f=fixture(t);
    assert.throws(()=>f.content.write(async db=>{db.prepare('INSERT INTO disk_content_batches VALUES(?,?)').run('never','[]');}),/DISK_TRANSACTION_ASYNC/);
    assert.equal(f.content.batch('never'),null);
    assert.throws(()=>f.repository.atomic(()=>f.content.write(async()=>{})),/DISK_TRANSACTION_ASYNC/);
});
test('共享健康状态按 revision CAS，旧 Logical history 保守隔离且 mediaIndex 不信任客户端范围',t=>{
    const f=fixture(t),first=f.file('first','alice',Buffer.from('abc'),50);
    first.fileIdHistory=[{fileId:'historical',messageId:49}];first.mediaIndex={mode:'indexed',ranges:[{offset:-1,size:99999}]};
    const a=f.save(first),b=f.save(f.file('second','bob',Buffer.from('abc'),51));
    assert.equal(f.content.withDatabase(db=>db.prepare('SELECT count(*) AS n FROM disk_content_legacy_history').get().n),1);
    assert.equal(f.repository.load('files')[0].mediaIndex.mode,'unavailable');
    assert.equal(f.content.setHealth(a.contentId,999,false,'stale'),false);
    assert.equal(f.content.setHealth(a.contentId,1,false,'TELEGRAM_400'),true);
    assert.equal(f.repository.load('files')[1].lastPhysicalError,'TELEGRAM_400');
    assert.equal(f.content.find(digest('abc'),3),null);
    Object.assign(a,f.file('first','alice',Buffer.from('abc'),52),{contentPhysicalRepair:true});
    f.repository.replace('files',f.files,file=>file.id);
    const loaded=f.repository.load('files');assert.equal(loaded[1].fileId,'remote-52');
    assert.equal(loaded[1].lastPhysicalError,'');assert.ok(loaded[1].repairedAt>0);assert.equal(loaded[1].logicalContentVersion,1);
    assert.equal(loaded[1].contentId,b.contentId);
});
test('PoP 回源失败只退回普通上传，不授予共享引用，且释放读取 lease',async t=>{
    const f=fixture(t),bytes=Buffer.from('sample');f.save(f.file('a','alice',bytes,60));
    const proof=createContentProof({content:f.content,validate:async()=>true,open:async()=>{throw new Error('TELEGRAM_NETWORK_ERROR');}});
    const result=await proof.preflight({diskUser:{id:'bob'},diskScope:{diskSpace:''}},{name:'x',size:bytes.length,contentSha256:digest(bytes)},'');
    assert.deepEqual(result,{status:'miss'});
    assert.equal(f.content.withDatabase(db=>db.prepare('SELECT count(*) AS n FROM disk_content_leases').get().n),0);
});
test('Content claim 在独立连接之间互斥；过期 claimant 不可覆盖新 claim', async t => {
    const f=fixture(t), second=openDiskRepository(f.dir);
    const proof=createContentProof({content:f.content,validate:async()=>true});
    const req=id=>({diskUser:{id},diskScope:{diskSpace:''}}), file={name:'x',size:3,contentSha256:digest('abc')};
    const first=await proof.preflight(req('alice'),file,'');
    const otherProof=createContentProof({content:second.content,validate:async()=>true});
    assert.equal((await otherProof.preflight(req('bob'),file,'')).status,'wait');
    f.content.write(db=>db.prepare('UPDATE disk_content_claims SET expires_at=0').run());
    const next=await otherProof.preflight(req('bob'),file,'');
    assert.notEqual(next.uploadTicket,first.uploadTicket);
    assert.throws(()=>proof.consumeClaim(req('alice'),{...file,uploadTicket:first.uploadTicket},''),/CONTENT_CLAIM_EXPIRED/);
});

test('频道使用检测保留当前引用和待清理债务；超长 caption 不截断真实 ID', t=>{
    const f=fixture(t),a=f.save(f.file('a','alice',Buffer.from('abc'),70));
    assert.equal(f.content.usesChannel('-100'),true);assert.equal(f.content.usesChannel('-200'),false);
    f.remove('a');assert.equal(f.content.usesChannel('-100'),true);
    const cleanup=f.content.claimCleanup(Date.now()+120_000);f.content.finishCleanup(cleanup);
    assert.equal(f.content.usesChannel('-100'),false);
    const tooLong=f.file('long','alice',Buffer.from('xyz'),71);tooLong.parts[0].fileId='F'.repeat(1100);
    f.save(tooLong);
    const job=f.content.withDatabase(db=>db.prepare('SELECT * FROM disk_content_caption_jobs WHERE content_id=?').get(tooLong.contentId));
    assert.equal(job.state,'BLOCKED');assert.equal(job.error,'CONTENT_CAPTION_TOO_LONG');
    assert.equal(JSON.parse(job.payload).caption.includes(tooLong.parts[0].fileId),true);
    assert.equal(f.content.resolve(a.contentId).state,'DELETED');
});

test('运行期 Chat 字典保护 public/数字双表示的活跃 Anchor，且只隔离相同消息 ID',t=>{
    const f=fixture(t),bytes=Buffer.from('alias');
    const publicFile={...f.file('public','alice',bytes,601),channelId:'@legacy_channel',contentSha256:''};
    const numeric={...f.file('numeric','bob',bytes,601),channelId:'-1001234567890'};
    f.save(publicFile);f.save(numeric);
    f.remove('numeric');
    assert.equal(f.content.claimCleanup(Date.now()+120_000),null);
    assert.equal(f.content.withDatabase(db=>db.prepare("SELECT error FROM disk_content_cleanup WHERE purpose='unreferenced-content'").get().error),'CONTENT_ANCHOR_ALIAS_UNRESOLVED');
    const dictionary=createTelegramChatDictionary({dataDir:f.dir});
    dictionary.replace([{chatId:'-1001234567890',username:'@legacy_channel'}],dictionary.list().revision);
    assert.equal(f.content.usesChannel('-1001234567890'),true,'数字频道仍被 public 历史 revision 使用');
    assert.equal(f.content.usesChannel('@legacy_channel'),true);
    assert.equal(f.content.allowed({channelId:'-1001234567890',parts:[{messageId:601}]}),false);
    assert.equal(f.content.claimCleanup(Date.now()+240_000),null);
    assert.equal(f.content.withDatabase(db=>db.prepare("SELECT error FROM disk_content_cleanup WHERE purpose='unreferenced-content'").get().error),'CONTENT_ANCHOR_ALIAS_CONFLICT');
    const independent=f.save({...f.file('independent','carol',Buffer.from('other'),602),channelId:'-1001234567890'});
    f.remove('independent');
    const cleanup=f.content.claimCleanup(Date.now()+120_000);
    assert.equal(cleanup.physical.parts[0].messageId,602,'别名隔离不能阻塞同频道其它消息的清理');
});

test('频道使用检测在 Chat 字典运行期更新后识别待清理 public 债务',t=>{
    const f=fixture(t), dictionary=createTelegramChatDictionary({dataDir:f.dir});
    f.save({...f.file('old','alice',Buffer.from('old'),699),channelId:'@retired_channel',contentSha256:''});
    f.remove('old');
    assert.equal(f.content.usesChannel('-1001234567890'),false);
    dictionary.replace([{chatId:'-1001234567890',username:'@retired_channel'}],dictionary.list().revision);
    assert.equal(f.content.usesChannel('-1001234567890'),true);
    assert.equal(f.content.usesChannel('-1009876543210'),false);
});

test('未解析 public 标识的消息仅在可疑 ID 上保守隔离，字典改为不同 Chat 后可恢复清理',t=>{
    const f=fixture(t),bytes=Buffer.from('alias');
    f.save({...f.file('public','alice',bytes,603),channelId:'@unknown_channel',contentSha256:''});
    f.save({...f.file('numeric','bob',bytes,603),channelId:'-1001234567890'});
    f.remove('numeric');
    assert.equal(f.content.claimCleanup(Date.now()+120_000),null);
    const dictionary=createTelegramChatDictionary({dataDir:f.dir});
    dictionary.replace([{chatId:'-1009876543210',username:'@unknown_channel'}],dictionary.list().revision);
    const cleanup=f.content.claimCleanup(Date.now()+240_000);
    assert.equal(cleanup.physical.channelId,'-1001234567890');
    assert.equal(cleanup.physical.parts[0].messageId,603);
});

test('cleanup claim 后新增别名映射仍被发送前 guard 和完成确认拦截',t=>{
    const f=fixture(t),bytes=Buffer.from('alias'),dictionary=createTelegramChatDictionary({dataDir:f.dir});
    dictionary.replace([{chatId:'-1009876543210',username:'@changing_channel'}],dictionary.list().revision);
    f.save({...f.file('public','alice',bytes,604),channelId:'@changing_channel',contentSha256:''});
    f.save({...f.file('numeric','bob',bytes,604),channelId:'-1001234567890'});
    f.remove('numeric');
    const claimed=f.content.claimCleanup(Date.now()+120_000);
    assert.equal(claimed.physical.parts[0].messageId,604);
    dictionary.replace([{chatId:'-1001234567890',username:'@changing_channel'}],dictionary.list().revision);
    assert.equal(f.content.allowed(claimed.physical),false);
    f.content.finishCleanup(claimed);
    const row=f.content.withDatabase(db=>db.prepare('SELECT state,error FROM disk_content_cleanup WHERE id=?').get(claimed.id));
    assert.equal(row.state,'PENDING');assert.equal(row.error,'CONTENT_ANCHOR_ALIAS_CONFLICT');
});

test('旧 cleanup 债务不能抢先删除 DELETE_PENDING 的当前 Anchor；退休清理保留当前共用封面',t=>{
    const f=fixture(t),first=f.file('a','alice',Buffer.from('abc'),80);
    first.thumbnail={fileId:'cover',messageId:81,size:3};const a=f.save(first);
    const old={...a,parts:a.parts.map(part=>({...part}))};
    Object.assign(a,f.file('a','alice',Buffer.from('abc'),82),{contentPhysicalRepair:true});
    f.repository.replace('files',f.files,file=>file.id);
    const retired=f.content.claimCleanup();assert.equal(retired.purpose,'retired-revision');assert.equal(retired.physical.thumbnail,null);
    f.content.finishCleanup(retired);
    assert.equal(f.content.withDatabase(db=>db.prepare('SELECT state FROM disk_content_anchors WHERE message_id=81').get()).state,'ACTIVE');
    f.content.enqueue({...a},'legacy-debt');f.remove('a');
    assert.equal(f.content.allowed({...a}),false,'只有正式 unreferenced worker 先 fence generation 才允许删除');
    const debt=f.content.claimCleanup();assert.equal(debt.purpose,'legacy-debt');assert.equal(debt.physical.parts.length,0);assert.equal(debt.physical.thumbnail,null);
    f.content.finishCleanup(debt);assert.equal(f.content.resolve(a.contentId).state,'DELETE_PENDING');
    const gc=f.content.claimCleanup(Date.now()+120_000);assert.equal(gc.purpose,'unreferenced-content');
    assert.equal(f.content.resolve(a.contentId).state,'DELETING');assert.equal(f.content.allowed(gc.physical),true);
    assert.equal(gc.physical.parts[0].messageId,82);assert.equal(gc.physical.thumbnail.messageId,81);
    assert.equal(old.parts[0].messageId,80);
});

test('协同引用提交直接读取事务中的授权，拒绝另一连接撤销后仍留在内存的成员快照',async t=>{
    const f=fixture(t),original=f.save(f.file('original','alice',Buffer.from('abc'),90));
    const {createDiskCollaborationStore}=require('../server/disk-collaboration'),{createTelegramDriveStore}=require('../server/telegram-drive');
    const collaboration=createDiskCollaborationStore(f.dir),entry=collaboration.enable({ownerId:'alice',kind:'directory',path:'',name:'root'});
    collaboration.join(entry.invite.token,'bob');const granted=collaboration.authorized(entry.collaboration.id,'bob');
    const store=createTelegramDriveStore({dataDir:f.dir}),job=store.begin({owner:{id:'alice'},folderPath:'',progressive:true,files:[{name:'new',size:3}],channelId:'-100'});
    await store.setUploadContextAsync(job.id,{contentGrant:{id:granted.id,viewerId:'bob',version:granted.grantVersion}});
    await store.reuseContent(job.id,0,original.contentId,f.content.lease(original.contentId,'bob',job.id));
    f.content.write(db=>{
        const row=db.prepare("SELECT payload FROM disk_collaborations WHERE scope='' AND id=?").get(granted.id),changed=JSON.parse(row.payload);
        changed.members=[];changed.memberVersions.bob++;
        db.prepare("UPDATE disk_collaborations SET payload=? WHERE scope='' AND id=?").run(JSON.stringify(changed),granted.id);
    });
    assert.ok(collaboration.authorized(granted.id,'bob'),'本进程仍保留旧 JS 快照');
    assert.throws(()=>store.commit(job.id,'-100',store.uploadResults(job.id)),/COLLABORATION_NOT_FOUND/);
    assert.equal(f.content.references(original.contentId).length,1);assert.equal(f.repository.load('files').length,1);
    await store.abortAsync(job.id);
});
