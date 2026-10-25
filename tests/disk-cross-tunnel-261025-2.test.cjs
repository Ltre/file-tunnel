'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),os=require('node:os'),path=require('node:path');
const {createTunnelAccess}=require('../server/tunnel-access');
const server=fs.readFileSync('server.js','utf8'),app=fs.readFileSync('app.js','utf8');
const section=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
class Element {
    constructor(tag){this.tag=tag;this.children=[];this.value='';}
    append(...children){this.children.push(...children);} setAttribute(){} focus(){} close(){} remove(){}
    showModal(){queueMicrotask(()=>{this.children.find(n=>n.tag==='select').value='target-tunnel-B';this.children.find(n=>n.tag==='div').children[1].onclick();});}
}
test('disk forwarding keeps the original page and socket while passing the selected target to its bridge',async()=>{
    const calls=[],memory=new Map(),current={id:'source-tunnel-A'},socket={id:'original-socket'};
    let prepared=false;
    const context={File,Blob,queueMicrotask,document:{createElement:tag=>new Element(tag),body:new Element('body')},
        localStorage:{getItem:key=>memory.get(key),setItem:(key,value)=>memory.set(key,value)},sessionStorage:{getItem:()=>null,setItem:(...args)=>calls.push(['queued',...args])},
        window:{DiskUI:{setExporter:run=>calls.push(['exporter',run]),close:()=>calls.push(['close'])},DiskClient:{context:()=>({accountId:'fixed-account'}),read:async()=>{assert.ok(prepared,'send details precede disk content reads');return new Blob(['hello']);}}},alert:assert.fail};
    vm.runInNewContext(fs.readFileSync('client/disk-tunnel-adapter.js','utf8'),context);
    context.window.DiskTunnelAdapter.configure({deferPendingForward:true,target:()=>current,tunnels:async()=>[current,{id:'target-tunnel-B',shortCode:'BBBBB'}],
        prepareSend:async()=>{prepared=true;return{selection:{mode:'collection',remark:'remark'}};},navigate:id=>calls.push(['navigate',id]),send:()=>calls.push(['send-current']),sendTo:(files,target)=>calls.push(['send-target',files,target,socket])});
    await calls.find(c=>c[0]==='exporter')[1]([{id:'disk-id',name:'hello.txt',type:'text/plain',relativePath:'folder/hello.txt'}]);
    assert.equal(calls.some(c=>c[0]==='navigate'),false,'must not navigate or replace the active tunnel');
    assert.equal(calls.some(c=>c[0]==='close'),false,'disk view stays open');
    assert.equal(calls.some(c=>c[0]==='queued'),false,'must not create a navigation-dependent pending forward');
    const sent=calls.find(c=>c[0]==='send-target');assert.ok(sent);assert.equal(sent[2].id,'target-tunnel-B');assert.equal(sent[3],socket);
    assert.equal(await sent[1][0].text(),'hello');assert.equal(sent[1][0].relativePath,'folder/hello.txt');assert.equal(current.id,'source-tunnel-A');
});

function permissionsFixture(t){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'disk-forward-261025-2-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const tunnelAccess=createTunnelAccess(dir),source='source-tunnel-A',target='target-tunnel-B',provider='provider-device',viewer='viewer-only-B';
    const sessions=new Map([[source,{devices:new Map([[provider,{}]]),fileAssets:new Map(),history:[]}],[target,{devices:new Map([[viewer,{}]]),history:[]}]]);
    let readable=true;
    sessions.get(source).fileAssets.set('forwarded-file',{metadata:{id:'forwarded-file'}});
    const context={sessions,tunnelAccess,canUseTunnelCapability:(_s,_d,capability)=>readable&&capability==='read'};
    const helper=section(server,'function canReadForwardedFile(', 'function getSessionPermissionPayload(');
    assert.ok(helper,'the forwarded-file grant must be checked by the actual server middleware helper');vm.runInNewContext(helper,context);
    return {...context,source,target,provider,viewer,setReadable:value=>{readable=value;}};
}
test('a target-only viewer can request exactly its forwarded file without acquiring source tunnel access',t=>{
    const f=permissionsFixture(t),file={id:'forwarded-file',backupSourceSessionId:f.source,forwardedSourceGrant:f.tunnelAccess.issueFileForward(f.source,f.target,'record-id','forwarded-file')};
    f.sessions.get(f.target).history.push({message:{id:'record-id',type:'file',fileInfo:file}});
    assert.equal(f.canReadForwardedFile(f.target,f.viewer,f.source,file.id),true);
    assert.equal(f.canReadForwardedFile(f.target,f.viewer,f.source,'private-file'),false);
    assert.equal(f.canReadForwardedFile(f.target,'outsider',f.source,file.id),false);
    assert.equal(f.canReadForwardedFile(f.target,f.viewer,'another-source',file.id),false);
    assert.equal(f.tunnelAccess.verify('',f.source,f.viewer),false,'target receipt is not general source membership');
    file.forwardedSourceGrant+='x';assert.equal(f.canReadForwardedFile(f.target,f.viewer,f.source,file.id),false);
});
test('signed forwarded record remains authorized while its volatile source provider index is absent',t=>{
    const f=permissionsFixture(t),file={id:'forwarded-file',backupSourceSessionId:f.source,forwardedSourceGrant:f.tunnelAccess.issueFileForward(f.source,f.target,'record-id','forwarded-file')};
    f.sessions.get(f.target).history.push({message:{id:'record-id',type:'file',fileInfo:file}});
    f.sessions.get(f.source).fileAssets.clear();
    assert.equal(f.canReadForwardedFile(f.target,f.viewer,f.source,file.id),true,'provider discovery must not be blocked as an authorization failure');
});

test('removing a target record or refusing read permission removes its forwarded-file access',t=>{
    const f=permissionsFixture(t),file={id:'forwarded-file',backupSourceSessionId:f.source,forwardedSourceGrant:f.tunnelAccess.issueFileForward(f.source,f.target,'record-id','forwarded-file')};
    f.sessions.get(f.target).history.push({message:{id:'record-id',type:'collection',collection:{files:[file]}}});
    assert.equal(f.canReadForwardedFile(f.target,f.viewer,f.source,file.id),true);
    f.setReadable(false);assert.equal(f.canReadForwardedFile(f.target,f.viewer,f.source,file.id),false);f.setReadable(true);
    f.sessions.get(f.target).history=[];assert.equal(f.canReadForwardedFile(f.target,f.viewer,f.source,file.id),false);
});

test('forwarded-file signatures cannot be replayed in another record, source, destination or file',t=>{
    const f=permissionsFixture(t),token=f.tunnelAccess.issueFileForward(f.source,f.target,'record-1','forwarded-file');
    const valid=(...scope)=>f.tunnelAccess.verifyFileForward(token,...scope);
    assert.equal(valid(f.source,f.target,'record-1','forwarded-file'),true);
    assert.equal(valid(f.source,f.target,'record-2','forwarded-file'),false);
    assert.equal(valid(f.source,'other-target','record-1','forwarded-file'),false);
    assert.equal(valid('other-source',f.target,'record-1','forwarded-file'),false);
    assert.equal(valid(f.source,f.target,'record-1','private-file'),false);
    assert.doesNotThrow(()=>assert.equal(f.tunnelAccess.verifyFileForward('f1.'+'中'.repeat(43),f.source,f.target,'record-1','forwarded-file'),false));
    for(const malformed of ['',null,{},token+'x','f1.'+'!'.repeat(43)])assert.equal(f.tunnelAccess.verifyFileForward(malformed,f.source,f.target,'record-1','forwarded-file'),false);
    f.sessions.get(f.target).history=[{message:{id:'record-2',type:'file',fileInfo:{id:'forwarded-file',backupSourceSessionId:f.source,forwardedSourceGrant:token}}}];
    assert.equal(f.canReadForwardedFile(f.target,f.viewer,f.source,'forwarded-file'),false);
    f.sessions.get(f.target).history[0].message.id='record-1';assert.equal(f.canReadForwardedFile(f.target,f.viewer,f.source,'forwarded-file'),true);
    f.sessions.get(f.source).fileAssets.delete('forwarded-file');assert.equal(f.canReadForwardedFile(f.target,f.viewer,f.source,'forwarded-file'),true,'volatile supply is separate from the signed file permission');
});

function forwardingFixture(t,{mode='collection',failAfter=Infinity}={}) {
    const f=permissionsFixture(t),handlers=new Map(),events=[],saved=[],deviceSockets=new Map(),targetSession=f.sessions.get(f.target);
    Object.assign(targetSession,{fileAssets:new Map(),historySize:0,deletedMessageIds:[]});
    const sourceSocket={id:'main-source-socket',connected:true,data:{},on:(name,fn)=>handlers.set(name,fn),
        to:()=>({emit:(name,data)=>events.push({name,data})}),emit:(name,data)=>{events.push({name,data});if(name==='file-asset-available')handlers.get(name)?.(data);},timeout(){return this;}};
    deviceSockets.set(f.provider,sourceSocket);
    const access=f.tunnelAccess.issue(f.target,'device-at-B');
    let canSend=true;
    const environment={...f,socket:sourceSocket,currentSession:f.source,currentDevice:f.provider,clientIp:'fixture',Buffer,console,
        sanitizeString:value=>String(value || ''),isValidDeviceId:value=>typeof value==='string'&&value.length>0,isValidSessionId:value=>typeof value==='string'&&value.length>0,
        infraStore:{getTunnel:()=>({}),findShortCodeForSession:()=> 'BBBBB'},MAX_MESSAGE_SIZE:1024*1024,MAX_HISTORY_MESSAGES:100,MAX_HISTORY_SIZE:1024*1024,
        getOrCreateTelegramSession:id=>f.sessions.get(id),canUseTunnelCapability:(session,device,capability)=>capability==='read'||canSend&&device==='device-at-B'&&capability==='sendFile',
        historyLog(){},summarizeHistoryMessage:value=>value,persistHistoryAudit(){},getSessionAuditFileAssets:()=>new Map(),
        emitToReadableSessionDevices:(_s,name,data)=>events.push({name,data}),scheduleSessionHistoryBroadcast(){}
    };
    vm.runInNewContext(section(server,'function createHistoryMessage(', 'function preserveNewestTelegramFileIds(')+section(server,'function addToSessionHistory(', 'function getSessionDeviceList(')+
        section(server,"    socket.on('forward-message'", "    socket.on('clipboard-update'"),environment);
    const {registerFileAssetHandlers}=require('../server/file-assets');
    const fileContext=(session,device)=>({sessions:f.sessions,deviceSockets,getSessionId:()=>session,getDeviceId:()=>device,sanitize:value=>String(value),historyLog(){},clientIp:'fixture',isValidId:value=>typeof value==='string'&&value.length>0});
    registerFileAssetHandlers(sourceSocket,fileContext(f.source,f.provider));
    const viewerHandlers=new Map(),received=[];
    const viewerSocket={id:'viewer-B',data:{},on:(name,fn)=>viewerHandlers.set(name,fn),to:()=>({emit(){}}),timeout(){return this;},emit(name,data,ack){
        events.push({name,data});if(name==='file-asset-relay-chunk')received.push(Buffer.from(data.chunk));ack?.(null,{ok:true});
    }};
    deviceSockets.set(f.viewer,viewerSocket);registerFileAssetHandlers(viewerSocket,fileContext(f.target,f.viewer));
    let middleware;
    const gateContext={...f,currentSession:f.target,currentDevice:f.viewer,trustedInternalClient:false,socket:{data:{},use:fn=>{middleware=fn;}},
        emitSocketError:(name,message)=>events.push({name,data:{message}})};
    vm.runInNewContext(section(server,'    socket.use(([event,data],next)=>{',"    socket.on('session-short-code-update'"),gateContext);
    let seq=0;const sourceState={socket:sourceSocket,sessionId:f.source,deviceId:f.provider,deviceName:'source device'};
    const appContext={window:{},state:sourceState,File,Blob,Date,Map,console,generateId:()=> 'generated-'+(++seq),nextHistoryTimestamp:()=>seq,
        RECORD_REMARK_MAX_LENGTH:200,showFileSendProcessingPlaceholder:()=>({update(){},close:()=>events.push({name:'progress-close'})}),
        authorizeTunnelSelection:async()=>{},askFileCollectionMode:async()=>mode===null?null:({mode,remark:'forward remark'}),
        tunnelDeviceId:()=> 'device-at-B',savedTunnelGrant:()=>access,showAppToast:message=>events.push({name:'toast',message}),
        fileToArrayBuffer:file=>file.arrayBuffer(),saveToStore:async(store,value)=>saved.push({store,value}),notifyMusicLibraryAssetAvailable(){},
        fileAssetTransfer:{announce:async asset=>handlers.get('file-asset-available')({sessionId:f.source,asset})},enqueueMediaPosterCache(){},refreshFileMessage:async()=>{},historyLog(){}};
    let attempts=0;
    sourceSocket.timeout=()=>({emit:(name,data,ack)=>++attempts>failAfter?ack(null,{ok:true,stored:false,reason:'message-too-large'}):handlers.get(name)(data,response=>ack(null,response))});
    vm.runInNewContext(section(app,'function createFileInfoFromFile(', 'function canEditWebZip(')+
        section(app,'async function storeAndAnnounceFileAsset(', 'async function storeAndAnnounceExternalFileAsset(')+
        section(app,'async function sendDiskFilesToTunnel(', 'async function maybeImportTransferHistoryBackupFile('),appContext);
    return {...f,handlers,events,saved,sourceState,sourceSocket,viewerHandlers,viewerSocket,received,
        send:files=>appContext.sendDiskFilesToTunnel(files,{id:f.target,shortCode:'BBBBB'}),
        incoming:(event,data)=>{let allowed=false;middleware([event,data],()=>{allowed=true;viewerHandlers.get(event)?.(data);});return allowed;},
        sourceCall:(event,data)=>new Promise(resolve=>handlers.get(event)(data,resolve)),
        setTargetGrant:value=>{appContext.savedTunnelGrant=()=>value;},setCanSend:value=>{canSend=value;},
        setHistoryLimit:value=>{environment.MAX_HISTORY_SIZE=value;},
        forward:message=>new Promise(resolve=>handlers.get('forward-message')({message,targetSessionId:f.target,targetDeviceId:'device-at-B',targetAccessGrant:access,fileSource:'disk-cache'},resolve))};
}

test('real bridge and socket handlers forward a collection in place and relay its bytes to a B-only device',async t=>{
    const f=forwardingFixture(t),files=[new File(['first bytes'],'first.txt',{type:'text/plain'}),new File(['second bytes'],'second.txt',{type:'text/plain'})];
    Object.defineProperty(files[1],'relativePath',{value:'folder/second.txt'});
    await f.send(files);
    assert.equal(f.sourceState.sessionId,f.source);assert.equal(f.sourceState.socket,f.sourceSocket);
    const message=f.sessions.get(f.target).history[0].message;assert.equal(message.type,'collection');assert.equal(message.remark,'forward remark');assert.equal(message.collection.files[1].relativePath,'folder/second.txt');
    assert.equal(f.sessions.get(f.source).history.length,0,'no extra source-tunnel message is published');
    const file=message.collection.files[0];
    assert.equal(f.incoming('file-asset-request',{sessionId:f.target,sourceSessionId:f.source,assetId:file.id}),true);
    assert.ok(f.events.some(event=>event.name==='file-asset-request'&&event.data.from===f.viewer));
    assert.equal(f.events.some(event=>event.name==='permission-denied'),false);
    const start=await f.sourceCall('file-asset-relay-start',{sessionId:f.source,to:f.viewer,asset:file});assert.equal(start.ok,true);
    const chunk=await f.sourceCall('file-asset-relay-chunk',{sessionId:f.source,to:f.viewer,assetId:file.id,chunk:await files[0].arrayBuffer()});assert.equal(chunk.ok,true);
    const done=await f.sourceCall('file-asset-relay-complete',{sessionId:f.source,to:f.viewer,assetId:file.id});assert.equal(done.ok,true);
    assert.equal(Buffer.concat(f.received).toString(),'first bytes');
    assert.equal(f.incoming('file-asset-request',{sessionId:f.target,sourceSessionId:f.source,assetId:'private-file'}),false);
    assert.equal(f.events.filter(event=>event.name==='toast').at(-1).message,'已转发到所选隧道');
});

test('split mode keeps separate records and short-code rotation never gives an unjoined viewer access',async t=>{
    const f=forwardingFixture(t,{mode:'split'});await f.send([new File(['one'],'one.txt',{type:'text/plain'}),new File(['two'],'two.txt',{type:'text/plain'})]);
    assert.equal(f.sessions.get(f.target).history.length,2);assert.ok(f.sessions.get(f.target).history.every(entry=>entry.message.type==='file'));
    const oldJoin=f.tunnelAccess.issueJoin(f.target,'BBBBB');assert.equal(f.tunnelAccess.verifyJoin(oldJoin,f.target,'CCCCC'),false);
    const file=f.sessions.get(f.target).history[0].message.fileInfo;
    f.sessions.get(f.target).devices.delete(f.viewer);
    assert.equal(f.incoming('file-asset-request',{sessionId:f.target,sourceSessionId:f.source,assetId:file.id}),false);
});

test('direct forwarding refuses missing target membership, denied target send permission and unregistered source files',async t=>{
    const f=forwardingFixture(t);f.setTargetGrant('invalid');
    await assert.rejects(f.send([new File(['one'],'one.txt',{type:'text/plain'})]),/目标隧道访问凭据无效/);assert.equal(f.sessions.get(f.target).history.length,0);
    const unregistered=await f.forward({id:'new-record',sender:f.provider,type:'file',fileInfo:{id:'unregistered-file'}});assert.equal(unregistered.error,'forward-file-cache-required');
    f.setCanSend(false);const rejected=await f.forward({id:'new-record',sender:f.provider,type:'file',fileInfo:{id:'unregistered-file'}});assert.equal(rejected.error,'permission-denied');
});

test('the permission toast preserves an explicit server reason instead of replacing it with unknown capability',()=>{
    const messages=[],context={state:{socket:{on:(_name,handler)=>{context.handler=handler;}}},showAppToast:message=>messages.push(message),TUNNEL_PERMISSION_LABELS:{sendFile:'发送文件'}};
    vm.runInNewContext(section(app,"    state.socket.on('permission-denied'", "    state.socket.on('tunnel-access-grant'"),context);
    context.handler({message:'来源隧道尚未获得访问权'});assert.equal(messages[0],'来源隧道尚未获得访问权');
});

test('split forwarding reports the exact confirmed file after a later record is refused and never retries it automatically',async t=>{
    const f=forwardingFixture(t,{mode:'split',failAfter:1});
    await assert.rejects(f.send([new File(['one'],'first.txt',{type:'text/plain'}),new File(['two'],'second.txt',{type:'text/plain'})]),/部分文件已转发：first\.txt/);
    assert.equal(f.sessions.get(f.target).history.length,1);assert.equal(f.sessions.get(f.target).history[0].message.fileInfo.name,'first.txt');
    assert.equal(f.events.some(event=>event.name==='toast'),false);
});

test('cancelling the send-mode chooser does not announce or publish any file',async t=>{
    const f=forwardingFixture(t,{mode:null});await f.send([new File(['one'],'one.txt'),new File(['two'],'two.txt')]);
    assert.equal(f.sessions.get(f.target).history.length,0);assert.equal(f.saved.length,0);assert.ok(f.events.some(event=>event.name==='progress-close'));
});

test('the actual forward handler does not broadcast an unstored record as if it succeeded',async t=>{
    const f=forwardingFixture(t);f.setHistoryLimit(1);
    await assert.rejects(f.send([new File(['one'],'one.txt',{type:'text/plain'})]),/转发记录未保存/);
    assert.equal(f.sessions.get(f.target).history.length,0);assert.equal(f.events.filter(event=>event.name==='message').length,0);
});
