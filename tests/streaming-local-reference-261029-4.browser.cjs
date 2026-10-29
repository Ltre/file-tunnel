'use strict';
// Exercise the actual reference store/read functions across fresh page contexts.
// OPFS below supplies a cloneable native test handle only. It is not the app's
// disabled OPFS cache driver and does not copy or cache any user's local media.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.argv[2]||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const {createFixture}=require('./support/streaming-console-fixture.cjs');
const code=fs.readFileSync(path.resolve('client/streaming-console.js'),'utf8');
const references=code.slice(code.indexOf('    function handleStore('),code.indexOf('    let peerMedia;'));
(async()=>{
 const f=await createFixture();let browser;
 try{
  f.app.get('/local-reference-audit',(_req,res)=>res.type('html').send(`<!doctype html><meta charset="utf-8"><script>
   let device='reference-fixture';const key=name=>'streaming:'+device+':'+name,localFiles=new Map();
   ${references}
   window.seed=async(id,body)=>{const root=await navigator.storage.getDirectory(),handle=await root.getFileHandle(id+'.txt',{create:true});const writer=await handle.createWritable();await writer.write(body);await writer.close();await handleStore('put',id,handle);return {kind:'local',fileId:id,name:id+'.txt',size:body.length};};
   window.read=async source=>(await localBlob(source)).text();window.changeDevice=value=>device=value;
  </script>`));
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.goto(f.base+'/local-reference-audit');
  const old=await page.evaluate(()=>seed('old','unchanged original bytes'));
  const results=[];
  for(let i=0;i<20;i++){
   await page.reload();const reads=await page.evaluate(source=>Promise.all(Array.from({length:4},()=>read(source))),old);
   assert.ok(reads.every(body=>body==='unchanged original bytes'));results.push({reload:i+1,successfulConcurrentReads:reads.length});
  }
  const newer=await page.evaluate(()=>seed('new','new selection'));
  assert.deepEqual(await page.evaluate(async([a,b])=>[await read(a),await read(b)],[old,newer]),['unchanged original bytes','new selection']);
  const wrongSize=await page.evaluate(async source=>{try{await read({...source,size:source.size+1});return 'unexpected success';}catch(e){return e.message;}},old);assert.equal(wrongSize,'missing');
  await page.reload();const wrongDevice=await page.evaluate(async source=>{changeDevice('other-device');try{await read(source);return 'unexpected success';}catch(e){return e.message;}},old);assert.equal(wrongDevice,'missing');
  assert.deepEqual(errors,[]);
  const report={environment:'Windows Chrome, isolated origin, native synthetic handle',reloads:results,oldStillReadableAfterNewImport:true,sizeMismatchRejected:true,otherDeviceCannotUseReference:true,originalIntermittentIncidentReproduced:false};
  fs.writeFileSync(path.resolve('.npm-cache/local-reference-261029-4.json'),JSON.stringify(report,null,2));console.log('PASS 20 reloads / 80 concurrent original-reference reads; new selection preserves the old reference; identity checks retained');
 }finally{await browser?.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
