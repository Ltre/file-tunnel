'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element {
    constructor(tag){this.tag=tag;this.children=[];this.textContent='';} append(...v){this.children.push(...v);} prepend(v){this.children.unshift(v);} replaceChildren(...v){this.children=v;} setAttribute(){} showModal(){} close(){} remove(){this.removed=true;}
    all(){return [this,...this.children.flatMap(v=>v.all?.()||[])];}
}
function fixture({operations=[],unverified=false,agree=false,state='saved'}={}){
    const body=new Element('body'),messages=[],opened=[],record={id:'saved-record',status:'completed',target:{accountId:'saved',accountName:'保存账号',partitionId:'partition-id',partitionName:'保存分区',diskSpace:'p-space',path:'多级/目录'},file:{name:'file.txt'},result:{items:[{id:'saved-file',name:'file.txt'}]}};
    const context={AbortController,setTimeout,clearTimeout,document:{body,createElement:tag=>new Element(tag)},localStorage:{getItem:()=> 'current'},confirm:message=>{messages.push(message);return agree;},
        DiskClient:{raw:async route=>route==='/me'?{identity:{id:'current'},accounts:[{identity:{id:'current',name:'当前账号'}}]}:{accounts:[{identity:{id:'saved',name:'保存账号'}}]},accountOperations:async()=>({accountId:'current',operations,unverified})},
        DiskPendingSave:{prepareServer:async()=>record,inspectSaved:async()=>({state,files:record.result.items}),update:async(_id,value)=>Object.assign(record,value),open:value=>{opened.push(value);return{url:'/disk?pendingSave='+value.id};}}};context.window=context;
    vm.runInNewContext(fs.readFileSync('client/disk-saved-location.js','utf8'),context);
    return {context,body,messages,opened,record};
}
for(const operations of [[],[{type:'upload',title:'正在上传.mp4',operation_id:'job'}]]) test('saved location shows destination and requires cross-account approval '+operations.length,async()=>{
    const f=fixture({operations});await f.context.DiskSavedLocation.openTask({source:'sns',task:{}});
    const text=f.body.all().map(n=>n.textContent).join('\n');assert.match(text,/保存账号.*ID saved/);assert.match(text,/保存分区.*partition-id/);assert.match(text,/\/多级\/目录\/file.txt/);assert.equal(f.opened.length,0);
    await f.body.all().find(n=>n.textContent==='前往查看').onclick();assert.equal(f.opened.length,0);assert.match(f.messages[0],/当前账号.*current/);assert.match(f.messages[0],operations.length?/正在上传.mp4/:/没有正在执行/);
});
test('accepting the pre-open confirmation opens the original receipt without uploading',async()=>{
    const f=fixture({agree:true,state:'login-required'});await f.context.DiskSavedLocation.openTask({});await f.body.all().find(n=>n.textContent==='前往查看').onclick();assert.deepEqual(f.opened,[f.record]);
});
test('unknown activity is never described as no active tasks',async()=>{
    const f=fixture({unverified:true});await f.context.DiskSavedLocation.confirmView(f.record);assert.match(f.messages[0],/无法核验/);assert.doesNotMatch(f.messages[0],/没有正在执行/);
});
