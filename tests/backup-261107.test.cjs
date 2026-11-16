'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createDataBackup}=require('../server/data-backup');
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'backup-261107-')),dataDir=path.join(root,'data');await fs.mkdir(dataDir);
 const objects=new Map(),uploads=[];const control={fail:true,remove:false};
 const storage={resolveTarget:async t=>t,listDirectories:async()=>[],mkdir:async()=>{},stat:async(_t,key)=>objects.get(key),
  put:async(_t,key,input,info)=>{
   if(control.fail && key.endsWith('b.txt')){control.fail=false;throw Error('TELEGRAM_504');}
   const chunks=[];for await(const chunk of input)chunks.push(chunk);const body=Buffer.concat(chunks);
   assert.equal(crypto.createHash('sha256').update(body).digest('hex'),info.expectedSha256);
   const value={size:body.length,body,file:{id:crypto.randomUUID(),metadata:info.metadata}};objects.set(key,value);uploads.push(key);
   if(control.remove && key.endsWith('b.txt')) { for(const name of objects.keys())if(name.endsWith('a.txt'))objects.delete(name); }
   if(control.repoint && key.endsWith('b.txt')) { for(const [name,saved] of objects)if(name.endsWith('a.txt'))objects.set(name,{...saved,file:{...saved.file,id:'replaced-index-id'}}); }
   return value;
  }};
 const service=createDataBackup({dataDir,tempDir:root,storage});
 t.after(async()=>{service.close();await service.wait();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
 await fs.writeFile(path.join(dataDir,'a.txt'),'first complete body');await fs.writeFile(path.join(dataDir,'b.txt'),'second complete body');
 await service.configure('full',{userId:'isolated',partitionId:'isolated',folderPath:''});
 return{service,objects,uploads,control};
}
test('retry returns an active accepted state and resumes confirmed files without saving them twice',async t=>{
 const f=await fixture(t),job=await f.service.start({mode:'full',requestId:'retry-backup-261107'});await f.service.wait();assert.equal(f.service.state().jobs[0].status,'failed');
 const resumed=await f.service.retry(job.id);assert.equal(resumed.status,'uploading');assert.equal(resumed.error,'');
 await f.service.wait();const done=f.service.state().jobs[0];assert.equal(done.status,'completed',done.error);assert.equal(done.completedFiles,done.totalFiles);
 assert.equal(f.uploads.filter(key=>key.endsWith('a.txt')).length,1);
 const manifest=JSON.parse([...f.objects.entries()].find(([key])=>key.endsWith('backup-manifest.json'))[1].body);
 for(const file of manifest.files)for(const segment of file.segments){const saved=f.objects.get(done.folder+'/'+segment.key);assert.ok(saved);assert.equal(saved.size,segment.size);assert.equal(crypto.createHash('sha256').update(saved.body).digest('hex'),segment.sha256);}
});

test('a changed remote file identity cannot leave a stale file ID in the completed manifest',async t=>{
 const f=await fixture(t);f.control.fail=false;f.control.repoint=true;
 const job=await f.service.start({mode:'full',requestId:'identity-backup-261107'});await f.service.wait();
 assert.equal(f.service.state().jobs[0].status,'failed');assert.match(f.service.state().jobs[0].error,/BACKUP_VERIFY_FAILED/);
 f.control.repoint=false;await f.service.retry(job.id);await f.service.wait();assert.equal(f.service.state().jobs[0].status,'completed');
 const manifest=JSON.parse([...f.objects.entries()].find(([key])=>key.endsWith('backup-manifest.json'))[1].body);
 assert.equal(manifest.files.find(file=>file.name==='a.txt').segments[0].fileId,'replaced-index-id');
 assert.equal(f.uploads.filter(key=>key.endsWith('a.txt')).length,1);
});
test('a previously confirmed file missing at final verification prevents a completed manifest and can be repaired by retry',async t=>{
 const f=await fixture(t);f.control.fail=false;f.control.remove=true;
 const job=await f.service.start({mode:'full',requestId:'verify-backup-261107'});await f.service.wait();
 assert.equal(f.service.state().jobs[0].status,'failed');assert.match(f.service.state().jobs[0].error,/BACKUP_VERIFY_FAILED/);
 assert.equal([...f.objects.keys()].some(key=>key.endsWith('backup-manifest.json')),false);
 f.control.remove=false;await f.service.retry(job.id);await f.service.wait();assert.equal(f.service.state().jobs[0].status,'completed');
});
