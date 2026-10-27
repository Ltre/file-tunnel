'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createStreamingPeers}=require('../server/streaming-peers');
const fs=require('node:fs'),vm=require('node:vm');

test('station peer signaling requires the exact viewer ticket, network candidate and provider; rechecks revocation',async()=>{
    let admitted=true,time=1000;const viewer={deviceId:'viewer',userId:'owner'},provider={deviceId:'H',userId:null};
    const relay=createStreamingPeers({now:()=>time,authorize:async(ticket,actor)=>{if(ticket!=='valid-ticket'||actor.deviceId!=='viewer'||!admitted)throw Error('STREAM_INVITATION_REQUIRED');return{key:'a'.repeat(64),source:{kind:'tunnel',sessionId:'source-A',fileId:'only-this-file'},size:100};},providers:()=>['H']});
    relay.poll(provider,'lan','provider-page','');relay.poll({deviceId:'unrelated'},'elsewhere','other-page','a'.repeat(64));
    const data={ticket:'valid-ticket',clientId:'viewer-page'};
    assert.deepEqual(await relay.candidates(viewer,'lan',data),['H:provider-page']);
    assert.deepEqual(await relay.candidates(viewer,'different-network',data),[]);
    await assert.rejects(relay.offer(viewer,'lan',{...data,provider:'unrelated:other-page',sdp:'offer'},()=>viewer));
    const offering=relay.offer(viewer,'lan',{...data,provider:'H:provider-page',sdp:'offer'},()=>viewer);
    await new Promise(setImmediate);const [offer]=relay.poll(provider,'lan','provider-page','');assert.equal(offer.sdp,'offer');assert.equal(offer.source,undefined,'signaling must not leak source proofs');
    await assert.rejects(relay.check({deviceId:'other'},'provider-page',offer.id));
    const descriptor=await relay.check(provider,'provider-page',offer.id);assert.equal(descriptor.source.fileId,'only-this-file');
    await relay.answer(provider,'provider-page',offer.id,'answer');assert.equal((await offering).sdp,'answer');
    admitted=false;await assert.rejects(relay.check(provider,'provider-page',offer.id),/INVITATION/);
    admitted=true;time+=300001;await assert.rejects(relay.check(provider,'provider-page',offer.id));relay.close();
});

test('disk peers require an advertised station cache, while joined tunnel providers need no viewer membership',async()=>{
    const relay=createStreamingPeers({authorize:async()=>({key:'b'.repeat(64),source:{kind:'disk'}}),providers:()=>[]});
    relay.poll({deviceId:'cached'},'lan','cached-page','b'.repeat(64));relay.poll({deviceId:'empty'},'lan','empty-page','');
    assert.deepEqual(await relay.candidates({deviceId:'viewer'},'lan',{ticket:'ticket',clientId:'viewer-page'}),['cached:cached-page']);relay.close();
});

test('worker streams a Range in bounded pieces, cancels without additional reads and never puts media in shell caches',async()=>{
    const events={},reads=[],body=new Uint8Array(2*1024*1024);body.fill(37);
    const self={location:{origin:'https://fixture.invalid'},addEventListener:(name,run)=>events[name]=run,clients:{get:async()=>({postMessage(data,ports){reads.push(data);ports[0].postMessage(data.op==='open'?{size:body.length,type:'video/mp4'}:{body:body.slice(data.start,data.end+1).buffer});}})}};
    const context={self,URL,Request,Response,ReadableStream,Uint8Array,ArrayBuffer,MessageChannel,setTimeout,clearTimeout,fetch:()=>{throw Error('unexpected fallback');}};
    vm.runInNewContext(fs.readFileSync(require.resolve('../service-worker.js'),'utf8'),context);
    const request=new Request('https://fixture.invalid/streaming-peer-media/'+'t'.repeat(32),{headers:{Range:'bytes=128-1048703'}});let response;
    events.fetch({request,clientId:'viewer',respondWith:value=>response=value});const result=await response;
    assert.equal(result.status,206);assert.equal(result.headers.get('content-range'),'bytes 128-1048703/2097152');
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()),body.slice(128,1048704));assert.ok(reads.filter(r=>r.op==='read').every(r=>r.end-r.start+1<=1024*1024));
    assert.equal(result.headers.get('cache-control'),'no-store');
});

test('real peer client joins adjacent disk cache ranges and transfers them without a source login or origin body read',async t=>{
    const pcs=new Map(),diagnostics=[];let serial=0,provider,reads=0;
    class Channel{
        constructor(){this.readyState='connecting';this.bufferedAmount=0;}
        send(data){queueMicrotask(()=>this.other.onmessage?.({data}));}
    }
    class PC{
        constructor(options){assert.deepEqual(JSON.stringify(options.iceServers),'[]');this.id=String(++serial);pcs.set(this.id,this);this.iceGatheringState='complete';}
        createDataChannel(){return this.channel=new Channel();}
        async createOffer(){return{type:'offer',sdp:this.id};}async createAnswer(){return{type:'answer',sdp:this.id};}
        async setLocalDescription(value){this.localDescription=value;}
        async setRemoteDescription(value){this.remote=value;if(value.type==='answer'){const peer=pcs.get(value.sdp),incoming=new Channel();incoming.other=this.channel;this.channel.other=incoming;peer.ondatachannel({channel:incoming});incoming.readyState=this.channel.readyState='open';this.channel.onopen?.();}}
        close(){if(this.connectionState==='closed')return;this.connectionState='closed';this.onconnectionstatechange?.();this.channel?.onclose?.();}
    }
    const payload=Uint8Array.from({length:65536},(_,i)=>i%251),actors={P:{deviceId:'P'},V:{deviceId:'V'}},key='d'.repeat(64);
    const relay=createStreamingPeers({authorize:async(token,actor)=>{assert.equal(token,'ticket-'+actor.deviceId);return{key,size:payload.length,type:'video/mp4',source:{kind:'disk'}};},providers:()=>[]});
    const instances=[];t.after(()=>{for(const peer of instances)peer.close();relay.close();});
    async function page(name){
        const handlers={},controller={postMessage(_data,ports){ports[0].postMessage({streamingPeer:1});ports[0].close();}},worker={controller,addEventListener:(event,run)=>handlers[event]=run};
        const actor=actors[name];let originReads=0;
        const call=async(route,_method,data,options={})=>{
            if(route==='/peers/validate')return{key,size:payload.length,type:'video/mp4'};
            if(route==='/peers/candidates'){const providers=await relay.candidates(actor,'lan',data);diagnostics.push([name,route,providers]);return{providers};}
            if(route==='/peers/offers'){const waiting=relay.offer(actor,'lan',data,()=>actor);await new Promise(setImmediate);provider.peer.accept(relay.poll(actors.P,'lan',provider.peer.headers()['X-Stream-Peer'],provider.peer.headers()['X-Stream-Cache']));return waiting;}
            const id=route.split('/')[2];if(route.endsWith('/check'))return relay.check(actor,options.headers['X-Stream-Peer'],id);
            if(route.endsWith('/answer'))return relay.answer(actor,options.headers['X-Stream-Peer'],id,data.sdp);throw Error(route);
        };
        const window={RTCPeerConnection:PC,crypto:require('node:crypto').webcrypto,navigator:{serviceWorker:worker}};
        const clientSource=fs.readFileSync(require.resolve('../client/streaming-peers.js'),'utf8');
        vm.runInNewContext(clientSource,{window,AbortController,MessageChannel,Date,URL,Blob,ArrayBuffer,Uint8Array,setTimeout,clearTimeout,
            fetch:async(_url,options)=>{originReads++;const match=/bytes=(\d+)-(\d+)/.exec(options.headers.Range);return{status:206,arrayBuffer:async()=>payload.slice(Number(match[1]),Number(match[2])+1).buffer};}});
        const peer=window.StreamingPeers.create({request:call,readSource:()=>{reads++;throw Error('no disk login');}});instances.push(peer);await new Promise(resolve=>setTimeout(resolve,20));
        assert.match(await peer.url({url:'/api/streaming/media/ticket-'+name,expiresAt:Date.now()+60000,size:payload.length,type:'video/mp4'},call),/streaming-peer-media/);
        const ask=(op,start,end)=>new Promise((resolve,reject)=>{const channel=new MessageChannel();channel.port1.onmessage=event=>{channel.port1.close();event.data.error?reject(Error(event.data.error)):resolve(event.data);};handlers.message({source:controller,data:{type:'streaming-peer-read',ticket:'ticket-'+name,op,start,end},ports:[channel.port2]});});
        return{peer,ask,originReads:()=>originReads};
    }
    provider=await page('P');await provider.ask('open');await provider.ask('read',0,32767);await provider.ask('read',32768,65535);
    relay.poll(actors.P,'lan',provider.peer.headers()['X-Stream-Peer'],provider.peer.headers()['X-Stream-Cache']);
    const viewer=await page('V');await viewer.ask('open');const result=await viewer.ask('read',0,65535);
    assert.deepEqual(new Uint8Array(result.body),payload);assert.equal(viewer.originReads(),0,JSON.stringify({diagnostics,pcs:pcs.size,headers:provider.peer.headers()}));assert.equal(provider.originReads(),2);assert.equal(reads,0);
});
