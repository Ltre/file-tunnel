'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createDataBackup } = require('../server/data-backup');

test('real object storage resumes the same split snapshot after service recreation and retains empty files', { timeout: 30000 }, async t => {
    const f = await require('./support/data-backup-261027-fixture.cjs').create(); t.after(() => f.close());
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-review-261027-')), source = path.join(root, 'source'); await fs.mkdir(source);
    t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('backup-review-261027-')); await fs.rm(root, { recursive: true, force: true }); });
    const original = Buffer.alloc(2500); for (let i = 0; i < original.length; i++) original[i] = i % 251;
    await fs.writeFile(path.join(source, 'large.bin'), original); await fs.writeFile(path.join(source, 'empty.bin'), '');
    const target = { userId: 'bob', partitionId: f.core.id, folderPath: '核心数据' }, mapping = { userId:'bob', diskSpace:f.core.scopeKey, sourceAppId:'system-backup', assertAuthorized() { assert.ok(f.auth.user('bob')); } };
    let failSecond = true; const uploads = [];
    const storage = {
        resolveTarget: value => { assert.equal(value.userId, 'bob'); assert.equal(value.partitionId, f.core.id); return {...value, diskSpace:f.core.scopeKey}; },
        listDirectories: () => f.api.spaces.get(f.core.scopeKey).listDirectories('bob').map(item => item.path),
        mkdir: (_target, key) => f.api.objectStorage.put(mapping, key + '/', Readable.from([]), {size:0}),
        stat: (_target, key) => f.api.objectStorage.stat(mapping, key),
        put: async (_target, key, input, options) => {
            const largeHash = crypto.createHash('sha256').update('large.bin').digest('hex');
            if (failSecond && key.includes(largeHash) && key.endsWith('/000002.part')) { failSecond=false; throw Error('REVIEW_INTERRUPTED'); }
            uploads.push(key); return f.api.objectStorage.put(mapping,key,input,options);
        }
    };
    const first=createDataBackup({dataDir:source,tempDir:root,storage,partBytes:1024}); await first.configure('core',target);
    const job=await first.start({mode:'core',requestId:'review-resume-261027'}); await first.wait(); assert.equal(first.state().jobs[0].status,'failed'); first.close();
    await fs.writeFile(path.join(source,'large.bin'),'source changed after failed upload');
    const resumed=createDataBackup({dataDir:source,tempDir:root,storage,partBytes:1024}); t.after(async()=>{resumed.close();await resumed.wait();});
    await resumed.retry(job.id); await resumed.wait(); const completed=resumed.state().jobs[0]; assert.equal(completed.status,'completed',completed.error);
    async function bytes(key) { const opened=await f.api.objectStorage.open(mapping,key),chunks=[];for await(const chunk of opened.stream)chunks.push(chunk);return Buffer.concat(chunks); }
    const manifest=JSON.parse(await bytes(completed.folder+'/backup-manifest.json'));
    const large=manifest.files.find(file=>file.name==='large.bin'), empty=manifest.files.find(file=>file.name==='empty.bin');
    assert.equal(large.size,original.length);assert.equal(large.segments.length,3);
    assert.deepEqual(Buffer.concat(await Promise.all(large.segments.map(part=>bytes(completed.folder+'/'+part.key)))),original);
    assert.equal(uploads.filter(key=>key===completed.folder+'/'+large.segments[0].key).length,1,'resuming must not upload the confirmed first segment again');
    assert.equal(empty.size,0);assert.equal((await bytes(completed.folder+'/'+empty.segments[0].key)).length,0);
    assert.ok(large.segments.every(part=>part.done&&part.fileId));
});

test('a backup abort reaches Telegram after the complete source body has already been read', {timeout:10000}, async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'backup-cancel-review-261027-'));
    const repository=require('../server/disk-repository').openDiskRepository(root);repository.replace('users',[{id:'owner',name:'Isolated backup owner'}],item=>item.id);
    const auth=require('../server/disk-auth').createDiskAuth({dataDir:root});
    const store=require('../server/telegram-drive').createTelegramDriveStore({dataDir:root});
    const operations=require('../server/disk-operations').createDiskOperations({dataDir:root});
    let started, release, telegramSignal;
    const entering=new Promise(resolve=>{started=resolve;});
    const api=require('../server/disk-api').createDiskAPI({dataDir:root,auth,defaultStore:store,operations,
        telegram:{upload:async(_backend,_files,_progress,_unused,context)=>new Promise((_resolve,reject)=>{
            telegramSignal=context.signal;release=()=>reject(Error('REVIEW_RELEASE'));context.signal.addEventListener('abort',()=>reject(Error('OPERATION_CANCELLED')),{once:true});started();
        }),remove:async()=>{},syncCaption:async()=>{}},
        getDefaultBackend:()=>({token:'isolated-backup-review',channelId:'-1001'}),getIdentity:()=>null,setIdentity:()=>{},getOrigin:()=> 'http://backup.invalid',maxDepth:()=>30,
        contentReuseMode:'off',contentCleanupMode:'observe'});
    t.after(async()=>{release?.();api.close();repository.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
    const body=Buffer.from('all bytes are ready before Telegram replies'),controller=new AbortController();
    const saving=api.objectStorage.put({userId:'owner',diskSpace:'',sourceAppId:'system-backup'},'cancelled.bin',Readable.from([body]),{size:body.length,signal:controller.signal});
    const completion=saving.then(()=>({success:true}),error=>({error}));
    await entering;controller.abort();
    let timer;const outcome=await Promise.race([completion,new Promise(resolve=>{timer=setTimeout(()=>resolve({timeout:true}),1500);})]);clearTimeout(timer);
    if(outcome.timeout){release();await completion;}
    assert.equal(telegramSignal.aborted,true,'cancelling a backup must not wait indefinitely for Telegram');
    assert.equal(outcome.timeout,undefined);assert.match(outcome.error?.message||'',/CANCELLED/);
    assert.equal(api.objectStorage.stat({userId:'owner',diskSpace:''},'cancelled.bin'),null);
});
