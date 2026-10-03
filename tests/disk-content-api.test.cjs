'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const express = require('express');
const { createTelegramDriveStore } = require('../server/telegram-drive');
const { createDiskAuth } = require('../server/disk-auth');
const { createDiskOperations } = require('../server/disk-operations');
const { createDiskAPI } = require('../server/disk-api');
const { createDiskTelegram } = require('../server/disk-telegram');
const { createTelegramUploadScheduler } = require('../server/telegram-upload-scheduler');
const { openDiskRepository } = require('../server/disk-repository');
const json = body => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const value = await predicate(); if (value) return value; await sleep(10); }
    throw new Error(description);
}
async function fixture(t, telegram) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'progressive-api-'));
    const store = createTelegramDriveStore({ dataDir }), auth = createDiskAuth({ dataDir }), operations = createDiskOperations({ dataDir });
    const user = auth.fromTelegram({ id: '1234' }), other = auth.fromTelegram({ id: '5678' });
    const storage = { token: 'test-token', channelId: '-100', baseUrl: 'https://example.test' };
    telegram ||= {};
    telegram.remove ||= async () => {};
    const api = createDiskAPI({ dataDir, defaultStore: store, auth, operations, telegram, getDefaultBackend: () => storage,
        getIdentity: req => req.get('X-Other') ? other : user, setIdentity() {}, getOrigin: () => 'http://localhost', isMockRequest: () => false, maxDepth: () => 20 });
    const app = express(); app.use(express.json()); app.use('/api/telegram/drive', api.browser);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/telegram/drive`;
    const request = async (url, options = {}) => { const response = await fetch(base + url, options); return { status: response.status, data: await response.json() }; };
    const create = async files => (await request('/uploads', { method: 'POST', ...json({ progressive: true, files }) })).data;
    const terminal = job => until(async () => {
        const result = (await request('/operations/' + job.operation_id)).data;
        return ['failed', 'completed', 'cancelled'].includes(result.status) ? result : null;
    }, 'operation remained running');
    t.after(async () => {
        api.close();
        for (const job of operations.list({ userId: user.id })) if (!['completed', 'failed', 'cancelled'].includes(job.status)) await operations.cancel(job.operation_id, { userId: user.id });
        for (const job of operations.list({ userId: user.id })) await store.upload(job.uploadId)?.pipelineDone;
        operations.flush(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        openDiskRepository(dataDir).close(); fs.rmSync(dataDir, { recursive: true, force: true });
    });
    return { api, dataDir, store, auth, operations, user, storage, telegram, base, request, create, terminal };
}
function remote(part, id) { return { ...part, streamFactory: undefined, awaitSourceComplete: undefined, fileId: `remote-${id}`, fileUniqueId: `unique-${id}`, messageId: id, messageDate: Date.now() }; }
function fakeTelegram() {
    let id = 100;
    return {
        async pushChunk(_backend, _file, part, update, context) {
            await context.onState('pushing', { attempt: 1 });
            let bytes = 0;
            for await (const buffer of part.streamFactory(context.signal)) { bytes += buffer.length; update({ telegramPartBytesSent: bytes }); }
            await part.awaitSourceComplete(context.signal);
            const value = remote(part, ++id); await context.onConfirmed(value); await context.onState('push_confirmed'); return value;
        },
        async finalizeGroups(_backend, _file, parts, context) { await context.onGroupConfirmed(parts, 0); return parts; },
        remove: async () => {}
    };
}

test('退出登录撤销 PoP 和已创建任务的最终 attach，不因额外 Authorization 头绕过',async t=>{
    t.mock.method(console,'info',()=>{});
    const f=await fixture(t,fakeTelegram()),cookie='drop2tunnel_telegram_drive='+Buffer.from(JSON.stringify({exp:Date.now()+60_000})).toString('base64url')+'.test';
    const headers={Cookie:cookie},file={name:'session.bin',size:3,contentSha256:hash('abc')};
    const job=(await f.request('/uploads',{method:'POST',...json({progressive:true,files:[file]}),headers:{...json({}).headers,...headers}})).data;
    await f.request(`/uploads/${job.uploadId}/files/0`,{method:'PUT',headers:{...headers,'Content-Range':'bytes 0-2/3'},body:'abc'});
    f.api.revokeContentSession({headers:{cookie}});
    const pre=await f.request('/content/preflight',{method:'POST',...json({files:[file]}),headers:{...json({}).headers,...headers,Authorization:'Bearer unrelated'}});
    assert.equal(pre.data.error,'CONTENT_SESSION_EXPIRED');
    await f.request(`/uploads/${job.uploadId}/finish`,{method:'POST',headers});
    const result=await f.terminal(job);assert.equal(result.status,'failed');assert.equal(result.errorCode,'CONTENT_SESSION_EXPIRED');
    assert.equal(f.store.adminFiles().length,0);
    assert.equal(openDiskRepository(f.dataDir).content.withDatabase(db=>db.prepare('SELECT count(*) AS n FROM disk_content_refs').get().n),0);
});

const crypto=require('node:crypto'), {Readable}=require('node:stream');
const {prefix}=require('../server/disk-content-proof');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
test('HTTP 全命中与跨用户持有证明：零正文、零新 Telegram 消息；mixed 整批提交',async t=>{
    t.mock.method(console,'info',()=>{});
    const telegram=fakeTelegram(),body=Buffer.from('shared-body');let sends=0;
    const original=telegram.pushChunk;
    telegram.pushChunk=async(...args)=>{sends++;return original(...args);};
    telegram.read=async()=>Readable.from([body]);telegram.check=async()=>{};
    const f=await fixture(t,telegram), first=await f.create([{name:'original',size:body.length,contentSha256:hash(body)}]);
    await f.request(`/uploads/${first.uploadId}/files/0`,{method:'PUT',headers:{'Content-Range':`bytes 0-${body.length-1}/${body.length}`},body});
    await f.request(`/uploads/${first.uploadId}/finish`,{method:'POST'});
    const completed=await f.terminal(first);assert.equal(completed.status,'completed',JSON.stringify(completed));
    const incoming={name:'copy',size:body.length,contentSha256:hash(body)};
    const pre=(await f.request('/content/preflight',{method:'POST',...json({files:[incoming]})})).data.files[0];
    assert.equal(pre.status,'reuse');
    const reuse=await f.create([{...incoming,reuseTicket:pre.reuseTicket}]);
    assert.equal(reuse.files[0].reused,true);
    await f.request(`/uploads/${reuse.uploadId}/finish`,{method:'POST'});
    const result=await f.terminal(reuse);assert.equal(result.status,'completed',JSON.stringify(result));
    assert.equal(sends,1);assert.equal(result.clientBytesReceived || 0,0);
    const headers={'X-Other':'1'},other={...incoming,name:'other-copy'};
    const challenge=(await f.request('/content/preflight',{method:'POST',...json({files:[other]}),headers:{...headers,...json({}).headers}})).data.files[0];
    assert.equal(challenge.status,'proof');
    const digests=challenge.ranges.map(range=>hash(Buffer.concat([prefix(challenge.nonce,range),body.subarray(range.offset,range.offset+range.size)])));
    const proved=(await f.request('/content/proof',{method:'POST',...json({ticket:challenge.ticket,digests}),headers:{...headers,...json({}).headers}})).data;
    const joined=(await f.request('/uploads',{method:'POST',...json({progressive:true,files:[{...other,reuseTicket:proved.reuseTicket},{name:'new',size:3}]}),headers:{...headers,...json({}).headers}})).data;
    const otherUser=f.auth.users().find(user=>user.telegramId==='5678');
    assert.equal(f.store.list(otherUser.id,'').files.length,0,'命中部分不能提前出现');
    await f.request(`/uploads/${joined.uploadId}/files/1`,{method:'PUT',headers:{...headers,'Content-Range':'bytes 0-2/3'},body:'xyz'});
    await f.request(`/uploads/${joined.uploadId}/finish`,{method:'POST',headers});
    const end=await until(async()=>{const op=(await f.request('/operations/'+joined.operation_id,{headers})).data;return ['completed','failed'].includes(op.status)&&op;},'mixed upload timeout');
    assert.equal(end.status,'completed',JSON.stringify(end));assert.equal(sends,2);assert.equal(f.store.list(otherUser.id,'').files.length,2);
    assert.equal(f.store.get(otherUser.id,completed.result.items[0].id),null,'共享不授予其它 Logical 访问权');
});
test('HTTP 空文件不发送 Telegram；客户端声明 hash 不符不能提交或复用',async t=>{
    t.mock.method(console,'info',()=>{});
    const telegram=fakeTelegram();let sends=0;const original=telegram.pushChunk;telegram.pushChunk=async(...args)=>{sends++;return original(...args);};
    const f=await fixture(t,telegram), empty=await f.create([{name:'empty',size:0}]);
    await f.request(`/uploads/${empty.uploadId}/finish`,{method:'POST'});
    assert.equal((await f.terminal(empty)).status,'completed');assert.equal(sends,0);
    const job=await f.create([{name:'wrong',size:3,contentSha256:hash('abc')}]);
    await f.request(`/uploads/${job.uploadId}/files/0`,{method:'PUT',headers:{'Content-Range':'bytes 0-2/3'},body:'xyz'});
    await f.request(`/uploads/${job.uploadId}/finish`,{method:'POST'});
    assert.equal((await f.terminal(job)).status,'failed');assert.equal(f.store.adminFiles().length,1);
    assert.equal(openDiskRepository(f.dataDir).content.find(hash('abc'),3),null);
    await f.store.upload(job.uploadId)?.pipelineDone;
    assert.equal(fs.readdirSync(path.join(f.dataDir,'telegram-drive-staging')).length,0,'明确 hash 错误不能保存成可自动恢复的成功候选');
});
test('mixed 批次失败不发布命中文件；回滚从不删除已共享 Anchor',async t=>{
    t.mock.method(console,'info',()=>{});
    const telegram=fakeTelegram(),body=Buffer.from('existing'),removed=[];
    telegram.remove=async(_backend,file)=>removed.push(...(file.parts || []).map(part=>part.messageId));
    telegram.check=async()=>{};
    const f=await fixture(t,telegram),first=await f.create([{name:'original',size:body.length,contentSha256:hash(body)}]);
    await f.request(`/uploads/${first.uploadId}/files/0`,{method:'PUT',headers:{'Content-Range':`bytes 0-${body.length-1}/${body.length}`},body});
    await f.request(`/uploads/${first.uploadId}/finish`,{method:'POST'});
    const original=await f.terminal(first);assert.equal(original.status,'completed');
    const item=f.store.adminFiles()[0],incoming={name:'reused',size:body.length,contentSha256:hash(body)};
    const pre=(await f.request('/content/preflight',{method:'POST',...json({files:[incoming]})})).data.files[0];
    const mixed=await f.create([{...incoming,reuseTicket:pre.reuseTicket},{name:'bad',size:3,contentSha256:hash('abc')}]);
    await f.request(`/uploads/${mixed.uploadId}/files/1`,{method:'PUT',headers:{'Content-Range':'bytes 0-2/3'},body:'xyz'});
    await f.request(`/uploads/${mixed.uploadId}/finish`,{method:'POST'});
    assert.equal((await f.terminal(mixed)).status,'failed');
    assert.deepEqual(f.store.adminFiles().map(file=>file.name),['original']);
    await f.api.retryRemoteCleanup();
    assert.equal(removed.includes(item.messageId),false);
    assert.equal(openDiskRepository(f.dataDir).content.references(item.contentId).length,1);
});
test('最终 caption 响应丢失后的 not-modified 视作幂等完成，Logical 改名不追加请求',async t=>{
    t.mock.method(console,'info',()=>{});
    const f=await fixture(t,fakeTelegram()),job=await f.create([{name:'caption.bin',size:3}]);
    await f.request(`/uploads/${job.uploadId}/files/0`,{method:'PUT',headers:{'Content-Range':'bytes 0-2/3'},body:'abc'});
    await f.request(`/uploads/${job.uploadId}/finish`,{method:'POST'});assert.equal((await f.terminal(job)).status,'completed');
    let captions=0;
    f.telegram.call=async(_backend,method,payload)=>{
        assert.equal(method,'editMessageCaption');assert.match(payload.caption,/message_id: 101/);
        assert.doesNotMatch(payload.caption,/user_id:|logical_file_id:|disk_space:|path:/);captions++;
        throw Object.assign(new Error('TELEGRAM_400'),{telegramDescription:'Bad Request: message is not modified'});
    };
    await f.api.retryCaptions();await f.api.retryCaptions();assert.equal(captions,1);
    const file=f.store.adminFiles()[0];f.store.update(f.user.id,file.id,{name:'renamed.bin'});
    await f.api.retryCaptions();assert.equal(captions,1);
});

test('协同 PoP 按实际成员的授权代次绑定，踢出再加入不能恢复旧 ticket 或在途 attach',async t=>{
    t.mock.method(console,'info',()=>{});
    const telegram=fakeTelegram(),body=Buffer.from('shared');telegram.read=async()=>Readable.from([body]);telegram.check=async()=>{};
    const f=await fixture(t,telegram),original=await f.create([{name:'source',size:body.length,contentSha256:hash(body)}]);
    await f.request(`/uploads/${original.uploadId}/files/0`,{method:'PUT',headers:{'Content-Range':`bytes 0-${body.length-1}/${body.length}`},body});
    await f.request(`/uploads/${original.uploadId}/finish`,{method:'POST'});assert.equal((await f.terminal(original)).status,'completed');
    await f.request('/directories',{method:'POST',...json({path:'shared'})});
    const enable=async()=>(await f.request('/collaborations/invitations',{method:'POST',...json({kind:'directory',path:'shared'})})).data;
    const invitation=await enable(),id=invitation.collaboration.id,headers={'X-Other':'1','Content-Type':'application/json'},scope='/collaboration-scope/'+id;
    const join=async invite=>f.request('/collaborations/join',{method:'POST',headers,body:JSON.stringify({token:invite.url.split('/').at(-1)})});
    await join(invitation);
    const member=f.auth.users().find(user=>user.telegramId==='5678').id;
    const proof=async name=>{
        const file={name,size:body.length,contentSha256:hash(body)};
        const challenge=(await f.request(scope+'/content/preflight',{method:'POST',headers,body:JSON.stringify({folderPath:'shared',files:[file]})})).data.files[0];
        assert.equal(challenge.status,'proof','不能借 owner 身份免除跨用户证明');
        const digests=challenge.ranges.map(range=>hash(Buffer.concat([prefix(challenge.nonce,range),body.subarray(range.offset,range.offset+range.size)])));
        const proved=(await f.request(scope+'/content/proof',{method:'POST',headers,body:JSON.stringify({ticket:challenge.ticket,digests})})).data;
        return {...file,reuseTicket:proved.reuseTicket};
    };
    const revokeAndRejoin=async()=>{
        await f.request('/collaborations/'+id+'/members/'+member,{method:'DELETE'});
        await join(await enable());
    };
    const stale=await proof('stale');await revokeAndRejoin();
    const denied=await f.request(scope+'/uploads',{method:'POST',headers,body:JSON.stringify({progressive:true,folderPath:'shared',files:[stale]})});
    assert.equal(denied.data.error,'CONTENT_PROOF_INVALID');
    const incoming=await proof('in-flight');
    const job=(await f.request(scope+'/uploads',{method:'POST',headers,body:JSON.stringify({progressive:true,folderPath:'shared',files:[incoming]})})).data;
    assert.ok(job.uploadId,JSON.stringify(job));await revokeAndRejoin();
    await f.request(scope+'/uploads/'+job.uploadId+'/finish',{method:'POST',headers});
    const terminal=await until(()=>{const op=f.operations.get(job.operation_id,{userId:f.user.id});return op && ['failed','completed'].includes(op.status) && op;},'revoked upload remained running');
    assert.equal(terminal.status,'failed');assert.equal(terminal.errorCode,'COLLABORATION_NOT_FOUND');
    assert.equal(f.store.list(f.user.id,'shared').files.length,0);
});

test('协同替换为空文件不发送 Telegram，只有目标 Logical 升级版本且其它引用继续有效',async t=>{
    t.mock.method(console,'info',()=>{});
    const telegram=fakeTelegram();telegram.upload=async()=>{throw new Error('zero-byte replacement must not send');};
    const f=await fixture(t,telegram),body=Buffer.from('original'),first=await f.create([{name:'first',size:body.length,contentSha256:hash(body)}]);
    await f.request(`/uploads/${first.uploadId}/files/0`,{method:'PUT',headers:{'Content-Range':`bytes 0-${body.length-1}/${body.length}`},body});
    await f.request(`/uploads/${first.uploadId}/finish`,{method:'POST'});assert.equal((await f.terminal(first)).status,'completed');
    const original=f.store.adminFiles()[0];
    f.store.putCopiedObject(f.user,'','twin',original,original.parts,f.storage,20);
    const invitation=(await f.request('/collaborations/invitations',{method:'POST',...json({kind:'file',fileId:original.id})})).data;
    await f.request('/collaborations/join',{method:'POST',headers:{'X-Other':'1',...json({}).headers},body:JSON.stringify({token:invitation.url.split('/').at(-1)})});
    const response=await f.request('/collaboration-scope/'+invitation.collaboration.id+'/files/'+original.id+'/repair',{method:'POST',headers:{'X-Other':'1','X-Disk-File-Size':'0','Content-Type':'application/octet-stream'},body:''});
    assert.equal(response.status,202,JSON.stringify(response.data));
    const result=await until(()=>{const op=f.operations.get(response.data.operation_id,{userId:f.user.id});return op && ['failed','completed'].includes(op.status) && op;},'empty replacement remained running');
    assert.equal(result.status,'completed',JSON.stringify(result));
    const after=f.store.get(f.user.id,original.id),twin=f.store.adminFiles().find(file=>file.name==='twin');
    assert.equal(after.size,0);assert.equal(after.logicalContentVersion,2);assert.notEqual(after.contentId,twin.contentId);
    assert.equal(twin.fileId,'remote-101');assert.equal(twin.logicalContentVersion,1);
    assert.equal(openDiskRepository(f.dataDir).content.resolve(after.contentId).physical.parts.length,0);
});


