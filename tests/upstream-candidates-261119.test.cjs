'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createUpstreamExits}=require('../server/upstream-exits');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'upstream-candidates-261119-'));
 const exits=createUpstreamExits({dataDir:dir,log(){}});
 t.after(async()=>{await exits.close();fs.rmSync(dir,{recursive:true,force:true});});
 const nodes=['default','allowed','forbidden'].map(name=>exits.saveNode(null,{name,server:'fixture.invalid',port:443,password:'synthetic'}));
 const save=(service,options={})=>exits.saveService(service,{defaultExit:nodes[0].id,mode:'ordered',order:[],includeDirect:false,revision:exits.publicConfig().services.find(s=>s.id===service).revision,...options});
 const attempts=async(url)=>{const seen=[];await exits.runTask({url},()=>assert.rejects(exits.content(url,async()=>{seen.push(exits.current().selected.id);throw Error('synthetic failure');}),/synthetic failure/));return seen;};
 return{exits,nodes,save,attempts,dir};
}
test('no selected candidates means no automatic fallback through other nodes',async t=>{
 const h=fixture(t);h.save('youtube');
 assert.deepEqual(await h.attempts('https://youtube.com/watch?v=empty'),[h.nodes[0].id]);
});
test('a legacy implicit ordering does not enable nodes before the first checkbox selection',async t=>{
 const h=fixture(t),[a,b,c]=h.nodes;h.save('youtube',{order:[b.id,c.id]});
 const file=path.join(h.dir,'upstream-exits.json'),config=JSON.parse(fs.readFileSync(file,'utf8'));delete config.services.youtube.enabledNodes;fs.writeFileSync(file,JSON.stringify(config));
 const legacy=createUpstreamExits({dataDir:h.dir,log(){}});try{
  assert.deepEqual(legacy.publicConfig().services.find(s=>s.id==='youtube').enabledNodes,[]);
  const seen=[];await legacy.runTask({url:'https://youtube.com/watch?v=legacy'},()=>assert.rejects(legacy.content('https://youtube.com/watch?v=legacy',async()=>{seen.push(legacy.current().selected.id);throw Error('synthetic');}),/synthetic/));assert.deepEqual(seen,[a.id]);
 }finally{await legacy.close();}
});
test('ordered and random rotation never use an unchecked node, including newly added nodes',async t=>{
 const h=fixture(t),[a,b,c]=h.nodes;
 for(const mode of ['ordered','random']){
  h.save('youtube',{mode,order:[b.id,'direct'],includeDirect:true});
  const seen=await h.attempts('https://youtube.com/watch?v='+mode);
  assert.equal(seen[0],a.id);assert.deepEqual(new Set(seen),new Set([a.id,b.id,'direct']));assert.ok(!seen.includes(c.id));
 }
 h.exits.saveNode(null,{name:'new after settings saved',server:'new.invalid',port:443,password:'synthetic'});
 h.save('youtube',{order:[b.id]});assert.deepEqual(await h.attempts('https://youtube.com/watch?v=new'),[a.id,b.id]);
 h.save('youtube',{order:[],enabledNodes:[b.id]});assert.deepEqual(await h.attempts('https://youtube.com/watch?v=unordered-selected'),[a.id,b.id]);
});
test('services retain independent saved selections and explicit first exits retain their meaning',async t=>{
 const h=fixture(t),[a,b,c]=h.nodes;h.save('youtube',{order:[b.id]});h.save('twitter',{defaultExit:'direct',order:[c.id]});
 assert.deepEqual(await h.attempts('https://youtube.com/watch?v=x'),[a.id,b.id]);
 assert.deepEqual(await h.attempts('https://x.com/user/status/1'),['direct',c.id]);
 const copy=createUpstreamExits({dataDir:h.dir,log(){}});try{assert.deepEqual(copy.publicConfig().services.find(s=>s.id==='youtube').order,[b.id]);}finally{await copy.close();}
 await h.exits.runTask({url:'https://youtube.com/watch?v=explicit',networkExit:c.id},async()=>{
  const seen=[];await h.exits.content('https://youtube.com/watch?v=explicit',async()=>{seen.push(h.exits.current().selected.id);return{id:'cached'};});
  assert.deepEqual(seen,[c.id]);
 });
});
