'use strict';
// Isolated evidence for 261030-1/14. No real tunnel, browser profile or Telegram data.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const source=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const turn=()=>new Promise(setImmediate);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function receiver({origin='http://localhost',storeGate,receivedGate}={}){
    const timers=new Map();let nextTimer=0,stored=null,received=false;
    const context=vm.createContext({window:{location:{origin},isSecureContext:origin==='http://localhost'},navigator:{},
        console:{info(){},warn(){},error(){}},Blob,ArrayBuffer,Uint8Array,DataView,
        setInterval:()=>0,clearInterval(){},setTimeout:(fn,ms)=>{const key=++nextTimer;timers.set(key,{fn,ms});return key;},clearTimeout:id=>timers.delete(id)});
    vm.runInContext(source('client/cache-store.js'),context);vm.runInContext(source('client/file-assets.js'),context);
    const cache=await context.window.createDrop2TunnelCacheStore(),progress=[],events=[],logs=[];
    const transfer=new context.window.FileAssetTransfer({getSessionId:()=> 'session-isolated',getSocket:()=>({connected:true,emit:(event,data)=>events.push({event,data})}),
        load:async()=>stored,store:async file=>{if(storeGate)await storeGate.promise;stored=file;},beginCacheWrite:file=>cache.beginWrite(file),
        onProgress:(id,name,value,transport)=>progress.push({value,transport}),onQueue(){},onDownloadIdle(){},onUnavailable(){},
        onReceived:async()=>{received=true;if(receivedGate)await receivedGate.promise;},log:(event,data)=>logs.push({event,data})});
    return {transfer,cache,progress,events,logs,timers,get stored(){return stored;},get received(){return received;}};
}

test('100 MiB received bytes stay below 100 percent until the actual cache store finishes',async()=>{
    const storeGate=deferred(),receivedGate=deferred(),f=await receiver({storeGate,receivedGate});
    const asset={id:'hundred-mib',name:'isolated.bin',size:100*1024*1024,type:'application/octet-stream'};
    f.transfer.desiredAssets.set(asset.id,'source');f.transfer.activeDownloads.add(asset.id);
    f.transfer.begin(asset.id,asset,'source','p2p','attempt-first');
    const chunk=new Uint8Array(64*1024);chunk.fill(71);
    for(let offset=0;offset<asset.size;offset+=chunk.byteLength)await f.transfer.queueChunk(asset.id,chunk.buffer,'attempt-first');
    assert.equal(f.transfer.transfers.get(asset.id).receivedSize,asset.size);assert.equal(f.progress.at(-1).value,99);
    const pending=f.transfer.complete(asset.id,'source','p2p','attempt-first');await turn();
    assert.equal(f.stored,null,'all received bytes do not establish a persisted cache');assert.equal(f.progress.at(-1).value,99);
    storeGate.resolve();await turn();
    assert.equal(f.stored.data.byteLength,asset.size);assert.equal(new Uint8Array(f.stored.data)[asset.size-1],71);
    assert.equal(f.progress.at(-1).value,100);assert.equal(f.received,true);assert.equal(f.transfer.desiredAssets.has(asset.id),false);
    receivedGate.resolve();await pending;
    const emitted=f.events.length;await f.transfer.request(asset.id,'source',asset);
    assert.equal(f.events.length,emitted,'a new request for complete local bytes does not request a second transfer');
    assert.ok(f.progress.every((value,index)=>!index||value.value>=f.progress[index-1].value),'a normal attempt never resets after it has advanced');
    assert.equal(f.progress.filter(value=>value.value===100).length,1);
});

test('a receive retry resets the next attempt to zero; changing an origin string alone does not do so',async()=>{
    const asset={id:'retry-signal',name:'tiny.bin',size:2,type:'application/octet-stream'};
    const origins=[];
    for(const origin of ['http://localhost','http://10.0.0.9']){
        const f=await receiver({origin});f.transfer.desiredAssets.set(asset.id,'source');f.transfer.activeDownloads.add(asset.id);
        f.transfer.begin(asset.id,asset,'source','p2p','attempt-first');await f.transfer.queueChunk(asset.id,new Uint8Array([3,4]).buffer,'attempt-first');
        f.transfer.retryDownload(asset.id,'source','receive-timeout');await turn();
        const retry=[...f.timers.values()].find(timer=>timer.ms===3000);assert.ok(retry);retry.fn();
        const request=f.events.find(event=>event.event==='file-asset-request');assert.equal(request.data.force,true);
        f.transfer.begin(asset.id,asset,'source','p2p','attempt-second');await f.transfer.queueChunk(asset.id,new Uint8Array([3,4]).buffer,'attempt-second');
        await f.transfer.complete(asset.id,'source','p2p','attempt-second');
        assert.deepEqual(f.progress.map(value=>value.value),[0,99,0,99,100]);assert.equal(f.transfer.retryTimers.size,0);
        origins.push(f.events.map(({event})=>event));
    }
    assert.deepEqual(origins[0],origins[1]);
});

test('P2P sender uses a distinct completion acknowledgement, after payload bytes have been queued',async()=>{
    const f=await receiver(),asset={id:'sender-order',name:'send.bin',size:2,data:new Uint8Array([1,2]).buffer};
    const ack=deferred(),messages=[],order=[];
    const channel={readyState:'open',send:data=>messages.push(data)};
    f.transfer.sendWithBackpressure=async(_channel,data)=>{messages.push(data);order.push(typeof data==='string'?JSON.parse(data).type:'bytes');};
    f.transfer.waitForTransferAck=()=>{order.push('wait-for-persisted-ack');return ack.promise;};
    const pending=f.transfer.sendViaDataChannel(channel,asset,null,'viewer','send-attempt');await turn();
    assert.equal(f.progress.at(-1).value,99);assert.deepEqual(order,['file-asset-start','bytes','wait-for-persisted-ack','file-asset-complete']);
    ack.resolve({ok:true});await pending;assert.equal(f.progress.at(-1).value,100);assert.equal(messages.filter(value=>value instanceof ArrayBuffer).length,1);
});

test('the receive timeout remains armed while complete() waits for a slow persistence step',async()=>{
    const storeGate=deferred(),f=await receiver({storeGate}),asset={id:'slow-store',name:'slow.bin',size:2,type:'application/octet-stream'};
    f.transfer.desiredAssets.set(asset.id,'source');f.transfer.activeDownloads.add(asset.id);
    f.transfer.begin(asset.id,asset,'source','p2p','slow-first');await f.transfer.queueChunk(asset.id,new Uint8Array([5,6]).buffer,'slow-first');
    const pending=f.transfer.complete(asset.id,'source','p2p','slow-first');await turn();
    assert.equal(f.stored,null);assert.equal(f.progress.at(-1).value,99);
    const receiveTimeout=[...f.timers.values()].find(timer=>timer.ms===30000);assert.ok(receiveTimeout,'the payload receive watchdog still covers the persistence phase');
    receiveTimeout.fn();await turn();
    assert.ok(f.logs.some(log=>log.event==='file-asset-retry-scheduled'&&log.data.reason==='receive-timeout'));
    const retry=[...f.timers.values()].find(timer=>timer.ms===3000);assert.ok(retry);retry.fn();
    assert.ok(f.events.some(({event,data})=>event==='file-asset-request'&&data.force));
    storeGate.resolve();await pending;assert.equal(f.stored.data.byteLength,2);
});

test('Chrome exposes a different picker branch for HTTP localhost versus an HTTP LAN origin',async()=>{
    const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
    const browser=await chromium.launch({channel:'chrome',headless:true});
    try{
        const context=await browser.newContext();await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>isolated origin capability probe</title>'}));
        const page=await context.newPage(),observed=[];
        for(const origin of ['http://localhost','http://10.0.0.9']){
            await page.goto(origin);observed.push(await page.evaluate(()=>({origin:location.origin,secure:isSecureContext,picker:typeof showOpenFilePicker,rtc:typeof RTCPeerConnection})));
        }
        assert.equal(observed[0].secure,true);assert.equal(observed[0].picker,'function');assert.equal(observed[1].secure,false);assert.equal(observed[1].picker,'undefined');assert.equal(observed[0].rtc,'function');assert.equal(observed[1].rtc,'function');
        const app=source('app.js'),start=app.indexOf('async function pickFilesForSending()'),end=app.indexOf('async function getDroppedFileEntries(',start);
        const branches=[];
        for(const secure of [true,false]){
            const fixture=vm.createContext({window:{isSecureContext:secure,showOpenFilePicker:async()=>{branches.push('file-system-picker');return [];}},
                document:{getElementById:()=>({click:()=>branches.push('file-input')})},historyLog(){},sendSelectedFiles:async()=>{}});
            vm.runInContext(app.slice(start,end)+';this.pick=pickFilesForSending;',fixture);await fixture.pick();
        }
        assert.deepEqual(branches,['file-system-picker','file-input']);
    }finally{await browser.close();}
});
