'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=p=>fs.readFileSync(p,'utf8');
const section=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
test('resource inventory finds a complete referenced cache stored under a different tunnel',async()=>{
    const source=read('app.js'),cached={id:'forward-file',sessionId:'source-B',name:'cached.txt',type:'text/plain',size:4,data:new Uint8Array(4).buffer};
    const context={Map,Set,ArrayBuffer,Blob,Uint8Array,fileCacheStore:null,
        getCurrentSessionMessages:async()=>[{id:'target-record',type:'file',fileInfo:{id:cached.id,name:cached.name,size:4}}],getCurrentSessionFileInventory:async()=>[],
        getFromStore:async(store,id)=>store==='files'&&id===cached.id?cached:null,getFavoriteMusicIds:()=>new Set(),getCollectionFiles:()=>[],getEditorAssetEntries:()=>[],extractFileRefIds:()=>[],getResourceReferenceKey:r=>r.messageId,
        document:{getElementById:()=>null},state:{sessionId:'target-A'}};
    vm.runInNewContext(section(source,'function getBinaryDataSize(', 'async function initFileCacheStore(')+section(source,'function createFileInventoryRecord(', 'async function getCurrentSessionFileInventory(')+section(source,'async function getSessionResourceInventory(', 'async function readWebWorkshopResource('),context);
    const resources=await context.getSessionResourceInventory();assert.equal(resources[0].hasLocalData,true);assert.equal(resources[0].hasReadableLocalSource,true);
});
test('an expired invitation closes the originating preview after the console opens',async()=>{
    let opened=false,closed=false;const source=read('client/streaming-console.js');
    const context={open:async()=>{opened=true;},inspectInvitation:async()=>{throw Error('STREAM_INVITE_EXPIRED');},error(){}};
    vm.runInNewContext(section(source,'    async function openInvitation(', '    async function sendMarkdown('),context);
    assert.equal(await context.openInvitation('expired',{onOpen:()=>{assert.ok(opened);closed=true;}}),false);assert.equal(closed,true);
});

test('a stalled local tunnel lookup releases sync so a subsequent refresh can recover',async()=>{
    const source=read('client/streaming-console.js');let stalled=true,requests=0;const errors=[];
    const context={setTimeout:(run,ms)=>setTimeout(run,ms===10000?5:ms),clearTimeout,account:()=> 'alice',initialized:true,syncFlight:null,
        config:{devices:()=>[],tunnels:()=>stalled?new Promise(()=>{}):Promise.resolve([])},
        request:async()=>{requests++;return{identity:{id:'alice'},invitations:[]};},currentAccount:'alice',currentUser:{id:'alice'},root:{querySelector:()=>({})},
        isOpen:()=>true,ui:{view:'discover'},refreshList:async()=>{},render:async()=>{},error:cause=>errors.push(cause.message),queueMicrotask};
    vm.runInNewContext(section(source,'    async function sync(force', '    function ensureUi('),context);
    const outcome=await Promise.race([context.sync().then(()=> 'settled'),new Promise(r=>setTimeout(()=>r('blocked'),80))]);
    assert.equal(outcome,'settled','a pending IndexedDB/session lookup must not permanently occupy syncFlight');
    assert.deepEqual(errors,['STREAM_TUNNEL_CONTEXT_TIMEOUT']);assert.equal(requests,0);
    stalled=false;await context.sync(true);assert.equal(requests,1);
});

test('empty disk files are rejected with their names before destination selection or disk reads',async()=>{
    let exporter;const alerts=[];const context={window:{DiskUI:{setExporter:run=>exporter=run}},alert:message=>alerts.push(message)};
    vm.runInNewContext(read('client/disk-tunnel-adapter.js'),context);
    context.window.DiskTunnelAdapter.configure({deferPendingForward:true,tunnels:assert.fail,prepareSend:assert.fail});
    await exporter([{id:'empty',name:'空文件.txt',size:0}]);assert.equal(alerts.length,1);assert.match(alerts[0],/0 B.*取消勾选/);assert.match(alerts[0],/空文件.txt/);
});

for(const before of [true,false])test('adding a record keeps existing program identities and inserts '+(before?'before':'after')+' the selected reference',async()=>{
    class Node{constructor(tag){this.tag=tag;this.children=[];this.value='';}append(...nodes){this.children.push(...nodes);}add(option){this.children.push(option);if(!this.value)this.value=option.value;}setAttribute(){}replaceChildren(){this.children=[];this.value='';}set selectedIndex(i){this.value=this.children[i]?.value||'';}}
    let body,navigation,actor='owner';const original={name:'station',configVersion:3,items:[{id:'first',name:'First'},{id:'second',name:'Second'}]},drafts={};
    const context={ready:Promise.resolve(),dirty:()=>false,open:async()=>{},account:()=>actor,config:{tunnels:async()=>[{sessionId:'tunnel',accessGrant:'grant'}],currentTunnel:()=> 'tunnel'},
        structuredClone,uid:()=> 'new-item',ui:{drafts},localConfig:()=>original,saveConfig(){},saveUi(){},closeDialog(){},navigate:(...args)=>navigation=args,reconcileRevision:async()=>{},
        request:async route=>route==='/tunnel-candidates'?{candidates:[{name:'Record text',kind:'text',source:{kind:'tunnel',sessionId:'tunnel',messageId:'record',fileId:'record'}}]}:route.endsWith('/edit-config')?original:{stations:[{id:'station',number:'01',name:'Station',local:true,manageable:true}]},
        document:{createElement:tag=>new Node(tag)},Option:class{constructor(text,value){this.text=text;this.value=value;}},t:value=>value,showDialog:(_title,node)=>body=node,
        button:(_title,run)=>({tag:'button',run})};
    vm.runInNewContext(section(read('client/streaming-console.js'),'    async function importRecord(', '    async function sendMarkdown('),context);
    await context.importRecord({id:'record',sessionId:'tunnel'});
    body.children.find(n=>n.tag==='select'&&n.size===6).value='second';const radios=body.children.find(n=>n.tag==='div').children.map(label=>label.children[0]);radios[0].checked=before;radios[1].checked=!before;
    body.children.find(n=>n.tag==='button').run();
    assert.deepEqual(Array.from(drafts.station.items,item=>item.id),before?['first','new-item','second']:['first','second','new-item']);
    assert.deepEqual(navigation,['edit','station']);assert.equal(original.items.length,2,'the saved baseline is not mutated before saving');
    actor='other';assert.throws(()=>body.children.find(n=>n.tag==='button').run(),/STREAM_OWNER_REQUIRED/);
});

test('saving a cover does not discard a newer selection made while saving',async()=>{
    const revoked=[],d={name:'Name',configVersion:1,items:[],coverPending:'old'},saved=[];let release;
    const covers=new Map([['station',{token:'old',blob:new Blob(['old']),url:'old-url'}]]);
    const context={saveFlights:new Map(),ui:{drafts:{station:d}},localConfig:()=>null,account:()=> 'owner',structuredClone,pendingCovers:covers,
        t:value=>value,reconcileRevision:async()=>{},saveConfig:(_id,value)=>saved.push(value),saveUi(){},URL:{revokeObjectURL:url=>revoked.push(url)},
        request:async(route)=>route.endsWith('/cover')?{coverId:'saved-hash'}:new Promise(resolve=>{release=resolve;})};
    vm.runInNewContext(section(read('client/streaming-console.js'),'    async function persistDraft(', '    function editor('),context);
    const flight=context.persistDraft('station',()=>{});await new Promise(setImmediate);
    d.coverPending='new';covers.set('station',{token:'new',blob:new Blob(['new']),url:'new-url'});
    release({configVersion:2});assert.equal(await flight,false);assert.equal(saved[0].coverId,'saved-hash');
    assert.equal(d.coverPending,'new');assert.equal(covers.get('station').url,'new-url');assert.deepEqual(revoked,[]);
});

test('saved file links carry the destination while the pending receipt retains control of account confirmation',()=>{
    let opened;const record={id:'receipt',status:'completed',target:{accountId:'original-account',diskSpace:'partition',path:'多级/目录'},result:{items:[{id:'file'}]}};
    const context={validId:()=>true,URLSearchParams,global:{open:url=>opened=url}};
    vm.runInNewContext(section(read('client/disk-pending-save.js'),'    function open(record)', '    async function getBlob('),context);context.open(record);
    const link=new URL(opened,'http://localhost');assert.equal(link.searchParams.get('disk_account'),'original-account');assert.equal(link.searchParams.get('disk_path'),'多级/目录');assert.equal(link.searchParams.get('disk_file'),'file');
    const ui=read('client/disk-ui.js'),entry=section(ui,'const telegramDriveEntryUrl', 'let telegramDriveEntryFlight');
    const state={URL,URLSearchParams,location:link};vm.runInNewContext(entry+'this.pending=telegramDriveEntryPending;',state);assert.equal(state.pending,false,'the ordinary URL navigator must not bypass receipt verification');
});

test('the real completed-receipt login prompt uses the login ID and replaces both translated placeholders',async()=>{
    const source=read('client/disk-ui.js'),start=source.indexOf('    const ensureAccount = async (accountId, record) =>');let options;
    const context={pendingSaveRead:async()=>({accounts:[]}),manageTelegramDriveAccounts:async value=>{options=value;return null;},window:{TunnelI18n:{t:(message,language)=>{assert.equal(language,undefined);return message;}}}};
    vm.runInNewContext(source.slice(start,source.indexOf('    try {',start))+'this.check=ensureAccount;',context);
    await context.check('internal-id',{status:'completed',target:{accountName:'本地 Mock 用户 999000003',accountTelegramId:'999000003'}});
    assert.equal(options.requiredId,'internal-id');assert.match(options.prompt,/ID 999000003/);assert.doesNotMatch(options.prompt,/\{[01]\}/);
});
