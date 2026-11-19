'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createUpstreamExits,serviceFor}=require('../server/upstream-exits');
const {referenceLanguages}=require('../server/youtube-reference-language');
const {downloadFileName}=require('../server/download-file-name');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'upstream-bugb-')),starts=[],stops=[];
 const exits=createUpstreamExits({dataDir:dir,idleMs:30,startRuntime:async node=>{starts.push(node);return{proxy:'http://127.0.0.1:50123',alive:()=>true,stop:()=>stops.push(node.id)};},...options});
 t.after(async()=>{await exits.close();fs.rmSync(dir,{recursive:true,force:true});});
 const node=name=>exits.saveNode(null,{name,server:'proxy.fixture.invalid',port:443,password:'private-'+name,verifyTls:true});
 const policy=(id,extra={})=>exits.saveService('youtube',{revision:exits.publicConfig().services.find(s=>s.id==='youtube').revision,defaultExit:id,mode:'ordered',order:[],includeDirect:false,...extra});
 return{exits,node,policy,starts,stops,dir};
}
test('configuration is independent per service, retains duplicate addresses, and never exposes passwords',async t=>{
 const h=fixture(t),a=h.node('A'),b=h.node('B');h.policy(a.id);
 assert.notEqual(a.id,b.id);assert.equal(h.starts.length,0);
 assert.equal(h.exits.publicConfig().services.find(s=>s.id==='twitter').configured,false);
 assert.doesNotMatch(JSON.stringify(h.exits.publicConfig()),/private-A|private-B/);
 assert.throws(()=>h.exits.saveNode(a.id,{...a,name:'stale',revision:0}),/修改/);
 const copy=createUpstreamExits({dataDir:h.dir});assert.equal(copy.publicConfig().nodes.length,2);await copy.close();
});
test('first failure advances in the configured order, then success locks all later operations',async t=>{
 const h=fixture(t),a=h.node('A'),b=h.node('B');h.policy(a.id,{order:[b.id,'direct'],includeDirect:true});
 await h.exits.runTask({url:'https://music.youtube.com/watch?v=1'},async()=>{
  const tried=[];await h.exits.content('https://music.youtube.com/watch?v=1',async()=>{await h.exits.ready();const id=h.exits.current().selected.id;tried.push(id);if(id===a.id)throw Error('fixture connection reset');return{id:'video',formats:[{}]};});
  assert.deepEqual(tried,[a.id,b.id]);
  await assert.rejects(h.exits.content('https://i.ytimg.com/cover',async()=>{assert.equal(h.exits.current().selected.id,b.id);throw Error('later failure');}),/later failure/);
  assert.equal(h.exits.current().selected.id,b.id);
 });
});
test('empty content does not lock the route; explicit direct is allowed without joining candidate rotation',async t=>{
 const h=fixture(t),a=h.node('A');h.policy(a.id);
 await h.exits.runTask({url:'https://youtube.com/watch?v=1',networkExit:'direct'},async()=>{
  const result=await h.exits.content('https://youtube.com/watch?v=1',async()=>{assert.equal(h.exits.current().selected.id,'direct');return{id:'cached'};});
  assert.equal(result.id,'cached');assert.equal(h.starts.length,0,'cached analysis does not start a component');
 });
 let attempts=0;await h.exits.runTask({url:'https://youtube.com/watch?v=2'},()=>assert.rejects(h.exits.content('https://youtube.com/watch?v=2',async()=>{attempts++;return{};}),/有效内容/));assert.equal(attempts,1);
});
test('direct follows the configured candidate position and a new task starts from its own default again',async t=>{
 const h=fixture(t),a=h.node('A'),b=h.node('B');h.policy(a.id,{order:['direct',b.id],includeDirect:true});
 const tried=[];
 await h.exits.runTask({url:'https://youtube.com/watch?v=one'},()=>h.exits.content('https://youtube.com/watch?v=one',async()=>{
  await h.exits.ready();const id=h.exits.current().selected.id;tried.push(id);if(id===a.id)throw Error('initial failed');return{id:'valid'};
 }));assert.deepEqual(tried,[a.id,'direct']);
 await h.exits.runTask({url:'https://youtube.com/watch?v=two'},async()=>{
  await h.exits.content('https://youtube.com/watch?v=two',async()=>{await h.exits.ready();assert.equal(h.exits.current().selected.id,a.id);return{id:'other'};});
 });
});
test('concurrent task scopes keep names/configuration and component leases independent',async t=>{
 const h=fixture(t),a=h.node('A');h.policy(a.id);let releaseOne,releaseTwo,readyOne,readyTwo;
 const oneReady=new Promise(r=>readyOne=r),twoReady=new Promise(r=>readyTwo=r);
 const task=ready=>h.exits.runTask({url:'https://youtube.com/watch?v=1'},async()=>{await h.exits.content('https://youtube.com/watch?v=1',async()=>{await h.exits.ready();return{id:'x'};});ready();await new Promise(r=>{if(!releaseOne)releaseOne=r;else releaseTwo=r;});});
 const one=task(readyOne);await oneReady;const two=task(readyTwo);await twoReady;
 assert.equal(h.starts.length,1);assert.equal(h.exits.publicConfig().runtimes[0].activeTasks,2);
 releaseOne();await one;await wait(50);assert.equal(h.stops.length,0);
 h.exits.saveNode(a.id,{...a,name:'renamed',password:'new-private',revision:1});
 releaseTwo();await two;await wait(55);assert.equal(h.stops.length,1);assert.equal(h.starts[0].name,'A');
 await h.exits.runTask({url:'https://youtube.com/watch?v=next'},async()=>{await h.exits.content('https://youtube.com/watch?v=next',async()=>{await h.exits.ready();return{id:'new'};});assert.equal(h.exits.current().selected.name,'renamed');});
});
test('cached formats do not lock an unverified exit, while existing command output locks the first actual format success',async t=>{
 const h=fixture(t),a=h.node('A'),b=h.node('B'),c=h.node('C');h.policy(a.id,{order:[b.id,c.id]});
 await h.exits.runTask({url:'https://youtube.com/watch?v=cache'},async()=>{
  const cached=await h.exits.content('https://youtube.com/watch?v=cache',async()=>({id:'cache',formats:[{format_id:'18'}]}));
  assert.equal(cached.formats[0].format_id,'18');assert.equal(h.exits.current().locked,false);assert.equal(h.exits.current().attempts[0].status,'cached');assert.equal(h.starts.length,0);
  const tried=[];
  await assert.rejects(h.exits.content('https://youtube.com/watch?v=cache',async()=>{
   await h.exits.ready();const id=h.exits.current().selected.id;tried.push(id);
   if(id===a.id){h.exits.observeCommand('[youtube] still extracting');throw Error('initial format lookup failed');}
   h.exits.observeCommand('[info] cache: Downloading 1 for');assert.equal(h.exits.current().locked,false);
   h.exits.observeCommand('mat(s): 18\n');assert.equal(h.exits.current().locked,true);
   throw Error('download failed after usable format');
  },()=>true),/download failed after usable format/);
  assert.deepEqual(tried,[a.id,b.id]);assert.equal(h.exits.current().selected.id,b.id);
  await assert.rejects(h.exits.content('https://i.ytimg.com/a',async()=>{assert.equal(h.exits.current().selected.id,b.id);throw Error('later cover failure');}),/later cover failure/);
 });
 assert.deepEqual(h.starts.map(n=>n.id),[a.id,b.id]);
});
test('legacy unconfigured calls and CLI arguments are unchanged; a configured direct task overrides inherited proxy only at the boundary',async t=>{
 const calls=[],h=fixture(t,{nativeFetch:async(...args)=>{calls.push(args);return new Response('ok');}});
 const args=['--cookies','fixture','https://youtube.com/watch?v=1'];assert.equal(h.exits.cliArgs(args),args);
 await h.exits.fetch('https://youtube.com/watch?v=1',{headers:{x:'y'}});assert.deepEqual(calls[0][1],{headers:{x:'y'}});
 h.policy('direct');await h.exits.runTask({url:'https://youtube.com/watch?v=1'},async()=>{await h.exits.content('https://youtube.com/watch?v=1',async()=>{await h.exits.ready();assert.deepEqual(h.exits.cliArgs(args).slice(0,2),['--proxy','']);return{id:'a'};});});
});
test('standalone streaming fetch retains its component until the response body finishes',async t=>{
 let finish;const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));finish=()=>controller.close();}});
 const h=fixture(t,{nativeFetch:async()=>new Response(body)}),a=h.node('A');h.policy(a.id);
 const response=await h.exits.fetch('https://youtube.com/file');await wait(60);assert.equal(h.stops.length,0);
 finish();await response.arrayBuffer();await wait(60);assert.equal(h.stops.length,1);
});
test('services and Chinese reference language fallback preserve intended boundaries',()=>{
 assert.equal(serviceFor('https://music.youtube.com/watch'),'youtube');assert.equal(serviceFor('https://api.telegram.org/bot/x'),'telegram');assert.equal(serviceFor('https://x.com/a'),'twitter');
 for(const [language,wanted]of [['zh-HK','zh-HK'],['zh_TW','zh-TW'],['zh-Hant','zh-TW'],['zh-CN','zh-CN'],['zh','zh-CN']])assert.deepEqual(referenceLanguages({language},'zh'),[wanted,'zh']);
 assert.deepEqual(referenceLanguages({},'ja'),['ja']);assert.deepEqual(referenceLanguages({},''),[]);
});
test('music download names join artists with fullwidth ampersands and keep ordinary video names intact',()=>{
 const task={platform:'youtube',mediaType:'song',songMetadata:{artist:'Artist A/Artist B',title:'Song'},outputFileName:'old.flac',url:'https://youtube.com/watch?v=123'};
 assert.equal(downloadFileName(task),'Artist A＆Artist B - Song.flac');assert.equal(downloadFileName({...task,mediaType:'video',title:'Title'}),'Title[YT][123].flac');
});
test('manual exit IP confirmation validates its response and never probes in the background',async t=>{
 let calls=0;const h=fixture(t,{nativeFetch:async url=>{calls++;assert.equal(url,'https://api.ipify.org/');return new Response('198.51.100.8');}});
 assert.equal(calls,0);const value=await h.exits.confirmExit('direct');assert.equal(value.ip,'198.51.100.8');assert.equal(value.exitName,'本机直连');assert.equal(calls,1);assert.equal(h.starts.length,0);
});
test('HTTP error bodies remain available to existing retry handlers, and writes are never automatically replayed',async t=>{
 let calls=0;const h=fixture(t,{nativeFetch:async()=>{calls++;return new Response(JSON.stringify({ok:false,parameters:{retry_after:7}}),{status:429,headers:{'Content-Type':'application/json'}});}}),a=h.node('A'),b=h.node('B');h.policy(a.id,{order:[b.id]});
 const response=await h.exits.fetch('https://youtube.com/metadata');assert.equal(response.status,429);assert.equal((await response.json()).parameters.retry_after,7);assert.equal(calls,2);
 calls=0;const write=await h.exits.fetch('https://youtube.com/upload',{method:'POST',body:'synthetic'});assert.equal(write.status,429);assert.equal(calls,1);await write.text();
});
test('Telegram read streams retain the selected service scope until the consumer finishes',async t=>{
 const h=fixture(t,{nativeFetch:async()=>new Response('metadata')}),a=h.node('A');h.exits.saveService('telegram',{revision:0,defaultExit:a.id,mode:'ordered',order:[],includeDirect:false});
 const service=h.exits.wrapService('telegram',{async readPart(){await(await h.exits.fetch('https://api.telegram.org/metadata')).text();return require('node:stream').Readable.from(['body']);}});
 const stream=await service.readPart();await wait(55);assert.equal(h.stops.length,0);let result='';for await(const chunk of stream)result+=chunk;assert.equal(result,'body');await wait(55);assert.equal(h.stops.length,1);
});
test('format requests validate the final analysis without rejecting optional playlist metadata or locking on it',async t=>{
 const h=fixture(t),a=h.node('A'),b=h.node('B');h.policy(a.id,{order:[b.id]});
 await h.exits.runTask({url:'https://youtube.com/watch?v=formats'},async()=>{
  h.exits.current().requireFormats=true;
  await h.exits.content('https://youtube.com/playlist',async()=>{await h.exits.ready();return{id:'album',entries:[{id:'track'}]};});
  assert.equal(h.exits.current().locked,false);assert.equal(h.exits.current().attempts[0].status,'auxiliary');
  const tried=[];await h.exits.analyze('https://youtube.com/watch?v=formats',async()=>{await h.exits.ready();const id=h.exits.current().selected.id;tried.push(id);return{id:'track',formats:id===a.id?[]:[{format_id:'18'}]};});
  assert.deepEqual(tried,[a.id,b.id]);assert.equal(h.exits.current().locked,true);assert.equal(h.exits.current().selected.id,b.id);
 });
});
test('request tracing reports real selected names, targets and outcomes while redacting credentials',async t=>{
 const logs=[],h=fixture(t,{log:event=>logs.push(event),nativeFetch:async()=>new Response('rate-limited',{status:429})}),a=h.node('A');h.policy(a.id);
 await h.exits.runTask({url:'https://youtube.com/watch?v=fixture'},async()=>{
  const response=await h.exits.fetch('https://user:credential@youtube.com/page?token=private-token');assert.equal(response.status,429);await response.text();
  await assert.rejects(h.exits.trace('https://api.telegram.org/botprivate-token/getFile',()=>{throw Error('private-A https://user:credential@youtube.com/?token=private-token');}),/private-A/);
 });
 const start=logs.find(x=>x.event==='request-start'),end=logs.find(x=>x.event==='request-finished');assert.equal(start.exitName,'A');assert.equal(end.status,429);assert.equal(end.ok,false);
 assert.ok(logs.some(x=>x.event==='request-failed'));assert.doesNotMatch(JSON.stringify(logs),/private-A|private-token|credential/);
});
