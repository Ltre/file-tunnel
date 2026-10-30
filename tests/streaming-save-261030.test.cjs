'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const code=fs.readFileSync(require('node:path').join(__dirname,'../client/streaming-console.js'),'utf8');
function section(a,b){return code.slice(code.indexOf(a),code.indexOf(b,code.indexOf(a)));}
test('one save waits for pending duration checks, retries failures and continues automatically',async()=>{
 let probes=0,release;const value={items:[{kind:'video',name:'test.mp4'}]};
 const context={t:x=>x,ensureDuration:item=>{probes++;if(probes===1)return Promise.reject(Error('temporary'));return new Promise(resolve=>{release=()=>{item.duration=42;resolve(42);};});}};
 vm.createContext(context);vm.runInContext(section('    async function checkSaveDurations(','    function ensureDuration('),context);
 let finished=false;const save=context.checkSaveDurations(value,()=>{},()=>true).then(()=>finished=true);await new Promise(setImmediate);assert.equal(probes,2);assert.equal(finished,false);release();await save;assert.equal(finished,true);
});
test('three failed checks identify the actual blocking program; leaving cancels continuation',async()=>{
 let probes=0;const context={t:x=>x,ensureDuration:()=>{probes++;return Promise.reject(Error('failed'));}};vm.createContext(context);vm.runInContext(section('    async function checkSaveDurations(','    function ensureDuration('),context);
 await assert.rejects(context.checkSaveDurations({items:[{kind:'audio',name:'blocked.mp3',durationError:'decode'}]},()=>{},()=>true),e=>e.message==='STREAM_DURATION_REQUIRED'&&e.details.includes('blocked.mp3')&&e.details.includes('decode'));assert.equal(probes,3);
 await assert.rejects(context.checkSaveDurations({items:[]},()=>{},()=>false),/CONTEXT_CHANGED/);
});
test('a lost save reply verifies the submitted version and does not repeat the committed write',async()=>{
 const d={name:'station',configVersion:3,items:[]},ui={stationId:'s',drafts:{s:d}};let puts=0,saved;
 const context={ui,account:()=> 'actor',localConfig:()=>d,structuredClone,t:x=>x,checkSaveDurations:async()=>{},reconcileRevision:async()=>{},syncSourceCache:async()=>{},saveUi(){},notice(){},saveConfig:(_id,x)=>saved=x,
  request:async(url,method)=>{if(method==='PUT'){puts++;throw Error('connection reset after commit');}assert.ok(url.endsWith('/revision'));return {matches:true,configVersion:4};},pendingCovers:new Map()};
 vm.createContext(context);vm.runInContext(section('    const saveFlights =','    async function reconcileRevision(')+section('    async function persistDraft(','    function editor('),context);
 assert.equal(await context.persistDraft('s',()=>{}),true);assert.equal(puts,1);assert.equal(saved.configVersion,4);
});

test('unchanged verified configuration saves without another PUT; changed configuration still writes',async()=>{
 for(const changed of [false,true]){
  const baseline={name:'station',configVersion:3,items:[]},d={...baseline,name:changed?'edited':'station'},ui={stationId:'s',drafts:{s:d}};let puts=0,saved;
  const context={ui,account:()=> 'actor',localConfig:()=>baseline,structuredClone,t:x=>x,checkSaveDurations:async()=>{},reconcileRevision:async()=>({matches:true,configVersion:3}),syncSourceCache:async()=>{},saveUi(){},notice(){},saveConfig:(_id,value)=>saved=value,request:async()=>{puts++;return {configVersion:4};},pendingCovers:new Map()};
  vm.createContext(context);vm.runInContext(section('    const saveFlights =','    async function reconcileRevision(')+section('    async function persistDraft(','    function editor('),context);
  assert.equal(await context.persistDraft('s',()=>{}),true);assert.equal(puts,changed?1:0);assert.equal(saved.configVersion,changed?4:3);
 }
});

test('reselected sources are not treated as verified merely because their visible metadata matches',async()=>{
 const item={id:'i',name:'same.png',kind:'image',size:10,type:'image/png',source:{kind:'local',fileId:'same',size:10}},baseline={name:'s',configVersion:3,items:[{...item,sourceSaved:true}]},d={...baseline,items:[item]},ui={stationId:'s',drafts:{s:d}};let puts=0;
 const c={ui,account:()=> 'actor',localConfig:()=>baseline,structuredClone,t:x=>x,checkSaveDurations:async()=>{},reconcileRevision:async()=>({matches:true,configVersion:3}),syncSourceCache:async()=>{},saveUi(){},notice(){},saveConfig(){},request:async()=>{puts++;return {configVersion:4};},pendingCovers:new Map()};
 vm.createContext(c);vm.runInContext(section('    const saveFlights =','    async function reconcileRevision(')+section('    async function persistDraft(','    function editor('),c);
 await c.persistDraft('s',()=>{});assert.equal(puts,1);
});
