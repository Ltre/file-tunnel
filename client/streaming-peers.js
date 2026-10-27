(function(global){
    'use strict';
    const BLOCK=1024*1024, LIMIT=64*BLOCK;
    function create({request,readSource}){
        if(!global.RTCPeerConnection)return null;
        async function bounded(call,route,method,data,options={}){
            const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,5000);
            options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
            try{return await call(route,method,data,{...options,signal:controller.signal});}
            finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
        }
        const rawRequest=request;request=(...args)=>bounded(rawRequest,...args);
        const id=global.crypto.randomUUID?.()||('peer-'+Date.now()+'-'+Math.random().toString(36).slice(2));
        const cache=new Map(),tickets=new Map(),connections=new Map(),connecting=new Map(),serving=new Set();let bytes=0,workerReady=false;
        const headers=()=>({'X-Stream-Peer':id,'X-Stream-Cache':[...new Set([...cache.values()].filter(v=>v.until>Date.now()).map(v=>v.key))].slice(0,64).join(',')});
        function retain(key,start,body){
            const name=key+':'+start,old=cache.get(name);if(old){bytes-=old.body.byteLength;cache.delete(name);}
            if(body.byteLength>BLOCK)return;
            for(const [k,v]of cache)if(v.until<Date.now()){cache.delete(k);bytes-=v.body.byteLength;}
            while((bytes+body.byteLength>LIMIT||cache.size>=512)&&cache.size){const [k,v]=cache.entries().next().value;cache.delete(k);bytes-=v.body.byteLength;}
            // The response buffer is transferred to the worker (detached in
            // this page). Retain an owned copy so it can still supply peers.
            cache.set(name,{key,start,body:body.slice(0),until:Date.now()+120000});bytes+=body.byteLength;
        }
        function cached(key,start,end){
            const parts=[];let cursor=start;
            while(cursor<=end){let chosen;for(const value of cache.values())if(value.key===key&&value.until>Date.now()&&value.start<=cursor&&value.start+value.body.byteLength>cursor&&(!chosen||value.start+value.body.byteLength>chosen.start+chosen.body.byteLength))chosen=value;
                if(!chosen)return null;const last=Math.min(end+1,chosen.start+chosen.body.byteLength);parts.push(new Uint8Array(chosen.body,cursor-chosen.start,last-cursor));cursor=last;}
            const body=new Uint8Array(end-start+1);let at=0;for(const part of parts){body.set(part,at);at+=part.length;}return body.buffer;
        }
        async function description(pc){
            if(pc.iceGatheringState!=='complete')await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',changed);resolve();};const changed=()=>{if(pc.iceGatheringState==='complete')finish();};const timer=setTimeout(finish,1000);pc.addEventListener('icegatheringstatechange',changed);});
            return pc.localDescription.sdp;
        }
        function transport(pc,channel,expiresAt){
            channel.binaryType='arraybuffer';let queue=Promise.resolve(),pending,header,chunks=[],received=0;
            const closed=()=>{pending?.reject(Error('STREAM_PEER_UNAVAILABLE'));pending=null;};
            channel.onclose=closed;channel.onerror=closed;
            channel.onmessage=event=>{
                if(!pending)return;
                if(typeof event.data==='string'){
                    let value;try{value=JSON.parse(event.data);}catch(_){closed();return;}
                    if(value.error){closed();return;}if(value.id!==pending.id||value.bytes!==pending.size){closed();return;}
                    header=value;chunks=[];received=0;
                }else if(header&&event.data instanceof ArrayBuffer){
                    received+=event.data.byteLength;if(received>pending.size){closed();return;}chunks.push(new Uint8Array(event.data));
                    if(received===pending.size){const body=new Uint8Array(received);let at=0;for(const chunk of chunks){body.set(chunk,at);at+=chunk.length;}pending.resolve(body.buffer);pending=null;header=null;chunks=[];}
                }
            };
            async function read(start,end){
                if(Date.now()>=expiresAt||channel.readyState!=='open')throw Error('STREAM_PEER_UNAVAILABLE');
                return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{closed();pc.close();},6000);pending={id:Math.random().toString(36).slice(2),size:end-start+1,resolve:body=>{clearTimeout(timer);resolve(body);},reject:error=>{clearTimeout(timer);reject(error);}};channel.send(JSON.stringify({id:pending.id,start,end}));});
            }
            const expiry=setTimeout(()=>{closed();pc.close();},Math.max(0,expiresAt-Date.now()));
            pc.onconnectionstatechange=()=>{if(['failed','closed'].includes(pc.connectionState)){clearTimeout(expiry);closed();}};
            return {pc,expiresAt,read(start,end){const next=queue.catch(()=>{}).then(()=>read(start,end));queue=next;return next;}};
        }
        async function connectOnce(meta,ticket,call){
            const prior=connections.get(meta.key);if(prior&&prior.expiresAt>Date.now())return prior;
            const choices=await call('/peers/candidates','POST',{ticket,clientId:id});
            for(const provider of (choices.providers||[]).slice(0,1)){
                const pc=new global.RTCPeerConnection({iceServers:[]}),channel=pc.createDataChannel('stream-program',{ordered:true});
                const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),4000);
                try{
                    await pc.setLocalDescription(await pc.createOffer());
                    const answer=await call('/peers/offers','POST',{ticket,clientId:id,provider,sdp:await description(pc)},{signal:controller.signal});
                    if(!answer)throw Error('STREAM_PEER_UNAVAILABLE');
                    const opened=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('STREAM_PEER_UNAVAILABLE')),2500);channel.onopen=()=>{clearTimeout(timer);resolve();};channel.onerror=()=>{clearTimeout(timer);reject(Error('STREAM_PEER_UNAVAILABLE'));};});
                    await pc.setRemoteDescription({type:'answer',sdp:answer.sdp});await opened;
                    const link=transport(pc,channel,answer.expiresAt);connections.get(meta.key)?.pc.close();if(connections.size>=64){const [key,old]=connections.entries().next().value;old.pc.close();connections.delete(key);}connections.set(meta.key,link);return link;
                }catch(_){pc.close();}finally{clearTimeout(deadline);}
            }
            throw Error('STREAM_PEER_UNAVAILABLE');
        }
        function connect(meta,ticket,call){let flight=connecting.get(meta.key);if(!flight){flight=connectOnce(meta,ticket,call).finally(()=>connecting.delete(meta.key));connecting.set(meta.key,flight);}return flight;}
        async function accept(offer){
            if(serving.size>=8)return;const pc=new global.RTCPeerConnection({iceServers:[]});serving.add(pc);
            const close=()=>{clearTimeout(expiry);serving.delete(pc);pc.close();},expiry=setTimeout(close,300000);
            pc.onconnectionstatechange=()=>{if(['closed','failed'].includes(pc.connectionState))close();};
            pc.ondatachannel=event=>{
                const channel=event.channel;let work=Promise.resolve(),queued=0;channel.onclose=close;
                channel.onmessage=event=>{if(++queued>2){close();return;}work=work.catch(()=>{}).then(async()=>{
                    let data;try{
                        data=JSON.parse(event.data);if(!Number.isSafeInteger(data.start)||!Number.isSafeInteger(data.end)||data.start<0||data.end<data.start||data.end-data.start>=BLOCK)throw Error('STREAM_RANGE_INVALID');
                        // Recheck the viewer's station permission before every
                        // block. The descriptor is specific; it grants no tunnel membership.
                        const meta=await request('/peers/'+offer.id+'/check','POST',{}, {headers:headers()});
                        if(meta.key!==offer.key||data.end>=meta.size)throw Error('STREAM_RANGE_INVALID');
                        let body=cached(meta.key,data.start,data.end);
                        if(!body&&meta.source.kind!=='disk')body=await (await readSource(meta.source,{start:data.start,end:data.end})).arrayBuffer();
                        if(!body||body.byteLength!==data.end-data.start+1)throw Error('STREAM_PEER_UNAVAILABLE');
                        channel.send(JSON.stringify({id:data.id,bytes:body.byteLength}));
                        const started=Date.now();for(let start=0;start<body.byteLength;start+=16384){
                            while(channel.bufferedAmount>256*1024){if(channel.readyState!=='open'||Date.now()-started>6000)throw Error('STREAM_PEER_UNAVAILABLE');await new Promise(resolve=>setTimeout(resolve,10));}
                            channel.send(body.slice(start,start+16384));
                        }
                    }catch(_){if(channel.readyState==='open')channel.send(JSON.stringify({id:data?.id,error:true}));}
                }).finally(()=>{queued--;});};
            };
            try{await pc.setRemoteDescription({type:'offer',sdp:offer.sdp});await pc.setLocalDescription(await pc.createAnswer());await request('/peers/'+offer.id+'/answer','POST',{sdp:await description(pc)},{headers:headers()});}catch(_){close();}
        }
        async function open(ticket){
            const entry=tickets.get(ticket);if(!entry||entry.expiresAt<=Date.now())throw Error('STREAM_TICKET_EXPIRED');
            const meta=await entry.call('/peers/validate','POST',{ticket});entry.meta=meta;
            return {size:meta.size,type:meta.type};
        }
        async function read(ticket,start,end){
            const entry=tickets.get(ticket);if(!entry?.meta)throw Error('STREAM_TICKET_EXPIRED');
            if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end-start>=BLOCK||end>=entry.meta.size)throw Error('STREAM_RANGE_INVALID');
            const meta=entry.meta;let body=cached(meta.key,start,end);
            if(body)return body;
            if((entry.peerRetryAt||0)<Date.now())try{const peer=await connect(meta,ticket,entry.call);body=await peer.read(start,end);}catch(_){connections.get(meta.key)?.pc.close();connections.delete(meta.key);entry.peerRetryAt=Date.now()+15000;}
            if(!body){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
                try{const response=await fetch(entry.url,{headers:{Range:'bytes='+start+'-'+end},cache:'no-store',signal:controller.signal});if(response.status!==206)throw Error('STREAM_MEDIA_NETWORK_FAILED');body=await response.arrayBuffer();}finally{clearTimeout(timer);}
            }
            if(body.byteLength!==end-start+1)throw Error('STREAM_READ_INVALID');retain(meta.key,start,body);return body;
        }
        const worker=global.navigator?.serviceWorker;
        async function ping(){workerReady=false;if(!worker?.controller)return;const channel=new MessageChannel(),timer=setTimeout(()=>channel.port1.close(),700);channel.port1.onmessage=event=>{clearTimeout(timer);workerReady=event.data?.streamingPeer===1;channel.port1.close();};worker.controller.postMessage({type:'streaming-peer-ping'},[channel.port2]);}
        worker?.addEventListener('controllerchange',ping);ping();
        worker?.addEventListener('message',event=>{
            if(event.source!==worker.controller||event.data?.type!=='streaming-peer-read'||!event.ports?.[0])return;
            const port=event.ports[0],data=event.data;
            Promise.resolve().then(()=>data.op==='open'?open(data.ticket):read(data.ticket,data.start,data.end)).then(value=>{if(value instanceof ArrayBuffer)port.postMessage({body:value},[value]);else port.postMessage(value);},()=>port.postMessage({error:'STREAM_MEDIA_NETWORK_FAILED'})).finally(()=>port.close());
        });
        return {headers,accept:offers=>{for(const offer of offers||[])accept(offer).catch(()=>{});},
            async url(access,call,signal){
                const originalCall=call;call=(...args)=>bounded(originalCall,...args);
                const ticket=access.url.split('/').pop();for(const [key,value]of tickets)if(value.expiresAt<=Date.now())tickets.delete(key);if(tickets.size>=128)return access.url;tickets.set(ticket,{...access,call});
                for(const [key,value]of connections)if(value.expiresAt<=Date.now()){value.pc.close();connections.delete(key);}
                signal?.addEventListener('abort',()=>tickets.delete(ticket),{once:true});
                if(workerReady)return '/streaming-peer-media/'+ticket;
                // LAN HTTP has no Service Worker. Small assets can still use
                // direct cached bytes; large media retain native HTTP Range.
                if(access.size>0&&access.size<=16*BLOCK)try{
                    const meta=await call('/peers/validate','POST',{ticket}),peer=await connect(meta,ticket,call),parts=[];
                    for(let start=0;start<access.size;start+=BLOCK){if(signal?.aborted)throw Error('STREAM_READ_CANCELLED');const end=Math.min(access.size-1,start+BLOCK-1),part=await peer.read(start,end);retain(meta.key,start,part);parts.push(part);}
                    return URL.createObjectURL(new Blob(parts,{type:access.type}));
                }catch(_){}
                return access.url;
            },
            close(){for(const link of connections.values())link.pc.close();for(const pc of serving)pc.close();cache.clear();tickets.clear();}
        };
    }
    global.StreamingPeers={create};
})(window);
