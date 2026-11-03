'use strict';

// Last-resort X reader. One short-lived, isolated local Chromium process; no
// account/profile changes, persistent browser cache, browser download or new npm runtime.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const http=require('node:http'),WebSocket=require('ws');
const media=require('./twitter-post-media');
let busy=false;
function findBrowserBinary() {
    const candidates=[process.env.SNS_X_BROWSER_BIN,
        ...['PROGRAMFILES','PROGRAMFILES(X86)','LOCALAPPDATA'].flatMap(key=>process.env[key]?[path.join(process.env[key],'Google/Chrome/Application/chrome.exe'),path.join(process.env[key],'Microsoft/Edge/Application/msedge.exe')]:[]),
        '/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    return candidates.find(file=>file && fs.existsSync(file))||'';
}
function allowedRequest(value,type) {
    try {
        const url=new URL(value);
        return url.protocol==='https:' && !url.username && !url.password && !url.port &&
            ['x.com','www.x.com','twitter.com','www.twitter.com','api.x.com','api.twitter.com','abs.twimg.com','pbs.twimg.com','video.twimg.com','cdn.syndication.twimg.com'].includes(url.hostname) &&
            !['Image','Media','Font'].includes(type);
    } catch (_) {return false;}
}
async function connectDevTools(endpoint) {
    const target=new URL(endpoint);
    if(target.protocol!=='ws:'||target.hostname!=='127.0.0.1'||target.username||target.password)throw Error('SNS_X_BROWSER_CONNECT_FAILED');
    // A CDP connection is local control traffic, independent of the configured
    // outbound proxy. Do not mutate HTTP_PROXY/NO_PROXY or any shared agent.
    const agent=new http.Agent({proxyEnv:{}});
    const socket=new WebSocket(endpoint,{agent,perMessageDeflate:false,maxPayload:4*1024*1024,closeTimeout:1000}),pending=new Map(),listeners=new Set();let sequence=0;
    await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{socket.terminate();agent.destroy();reject(Error('SNS_X_BROWSER_CONNECT_FAILED'));},5000);
        socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
        socket.addEventListener('error',()=>{clearTimeout(timer);agent.destroy();reject(Error('SNS_X_BROWSER_CONNECT_FAILED'));},{once:true});
    });
    socket.addEventListener('message',event=>{
        let data;try{data=JSON.parse(String(event.data));}catch(_){return;}
        if(data.id){const request=pending.get(data.id);if(!request)return;pending.delete(data.id);clearTimeout(request.timer);data.error?request.reject(Error('SNS_X_BROWSER_PROTOCOL_FAILED')):request.resolve(data.result);}
        else for(const listener of listeners)listener(data);
    });
    const cancel=()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(Error('SNS_X_BROWSER_CLOSED'));}pending.clear();};
    socket.addEventListener('close',cancel);
    return {on:listener=>listeners.add(listener),send(method,params={},sessionId){
        if(socket.readyState!==WebSocket.OPEN||pending.size>=128)return Promise.reject(Error('SNS_X_BROWSER_CLOSED'));
        const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('SNS_X_BROWSER_TIMEOUT'));},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
    },close(){cancel();socket.close();agent.destroy();}};
}
async function readBrowserPost(value,{cookie='',proxy='',timeoutMs=22000,onDiagnostic=()=>{}}={}) {
    const report=details=>{try{onDiagnostic(details);}catch(_){}};
    const url=new URL(value),id=url.pathname.match(/^\/[^/]+\/status\/(\d+)/)?.[1];
    if(!id || !['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname)||url.protocol!=='https:'||url.username||url.password||url.port)throw Error('SNS_POST_URL_UNSUPPORTED');
    const binary=findBrowserBinary();if(!binary)throw Error('SNS_X_BROWSER_UNAVAILABLE');
    if(busy)throw Error('SNS_X_BROWSER_BUSY');busy=true;
    let profile,child,protocol,hardStop,done;
    const stop=()=>{try{child?.kill();}catch(_){}};
    try {
        profile=fs.mkdtempSync(path.join(os.tmpdir(),'tunnel-x-reader-'));
        const args=['--headless=new','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,
            '--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-sync','--mute-audio','--disable-gpu','--renderer-process-limit=2','about:blank'];
        let proxyUrl;
        if(proxy){proxyUrl=new URL(proxy);if(!['http:','https:','socks5:','socks5h:'].includes(proxyUrl.protocol))throw Error('SNS_X_BROWSER_PROXY_UNSUPPORTED');args.splice(-1,0,'--proxy-server='+proxyUrl.protocol.replace('socks5h:','socks5:')+'//'+proxyUrl.host);}
        child=spawn(binary,args,{stdio:['ignore','ignore','pipe'],windowsHide:true});
        done=new Promise(resolve=>child.once('close',resolve));process.once('exit',stop);
        const endpoint=await new Promise((resolve,reject)=>{
            let buffer='';const timer=setTimeout(()=>reject(Error('SNS_X_BROWSER_START_FAILED')),5000);
            child.once('error',()=>{clearTimeout(timer);reject(Error('SNS_X_BROWSER_START_FAILED'));});
            child.once('close',()=>{clearTimeout(timer);reject(Error('SNS_X_BROWSER_START_FAILED'));});
            child.stderr.on('data',chunk=>{buffer=(buffer+chunk).slice(-16000);const match=buffer.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
        });
        protocol=await connectDevTools(endpoint);
        const context=await protocol.send('Target.createBrowserContext',{disposeOnDetach:true});
        const target=await protocol.send('Target.createTarget',{url:'about:blank',browserContextId:context.browserContextId}),attached=await protocol.send('Target.attachToTarget',{targetId:target.targetId,flatten:true}),session=attached.sessionId;
        const send=(method,params)=>protocol.send(method,params,session),parts=[],requests=new Set();let bytes=0,overBudget=false,resolveInventory;
        const inventory=new Promise(resolve=>{resolveInventory=resolve;});
        protocol.on(event=>{
            if(event.sessionId!==session)return;
            const data=event.params||{};
            if(event.method==='Fetch.requestPaused'){const allowed=!overBudget&&allowedRequest(data.request?.url,data.resourceType);send(allowed?'Fetch.continueRequest':'Fetch.failRequest',allowed?{requestId:data.requestId}:{requestId:data.requestId,errorReason:'BlockedByClient'}).catch(()=>{});}
            if(event.method==='Fetch.authRequired')send('Fetch.continueWithAuth',{requestId:data.requestId,authChallengeResponse:data.authChallenge?.source==='Proxy'&&proxyUrl?.username?{response:'ProvideCredentials',username:decodeURIComponent(proxyUrl.username),password:decodeURIComponent(proxyUrl.password)}:{response:'CancelAuth'}}).catch(()=>{});
            if(event.method==='Network.dataReceived'){bytes+=data.dataLength||0;if(bytes>24*1024*1024&&!overBudget){overBudget=true;send('Page.stopLoading').catch(()=>{});resolveInventory();}}
            if(event.method==='Network.responseReceived' && /TweetResultByRestId|TweetDetail|\/tweet-result/.test(data.response?.url||'') && String(data.response.url).includes(id)){requests.add(data.requestId);report({phase:'focal-response',status:data.response.status});}
            if(event.method==='Network.loadingFinished' && requests.delete(data.requestId))send('Network.getResponseBody',{requestId:data.requestId}).then(response=>{
                if(response.body.length>3*1024*1024)return;
                const text=response.base64Encoded?Buffer.from(response.body,'base64').toString('utf8'):response.body;
                let post;try{post=media.fromJson(JSON.parse(text),id);}catch(_){return;}
                if(post){parts.push(post);report({phase:'focal-inventory',known:post.inventoryKnown,images:post.images.length,videos:post.videoIds.length});if(post.inventoryKnown)resolveInventory();}
            }).catch(()=>{});
        });
        await send('Network.enable',{maxTotalBufferSize:4*1024*1024,maxResourceBufferSize:2*1024*1024});
        await send('Network.setCacheDisabled',{cacheDisabled:true});
        await send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}],handleAuthRequests:true});
        if(cookie){const domain=url.hostname.includes('twitter.com')?'.twitter.com':'.x.com';const cookies=cookie.split('; ').flatMap(item=>{const at=item.indexOf('=');return at>0?[{name:item.slice(0,at),value:item.slice(at+1),domain,path:'/',secure:true,httpOnly:item.slice(0,at)==='auth_token'}]:[];});await send('Network.setCookies',{cookies});}
        const timeout=new Promise(resolve=>{hardStop=setTimeout(resolve,Math.min(30000,Math.max(1000,timeoutMs)));});
        await send('Page.enable');await send('Page.navigate',{url:url.href});await Promise.race([inventory,timeout]);clearTimeout(hardStop);
        if(!parts.some(post=>post.inventoryKnown)) {
            const html=await send('Runtime.evaluate',{expression:'document.documentElement.outerHTML',returnByValue:true});
            if(typeof html.result?.value==='string'&&html.result.value.length<3*1024*1024){const post=media.fromHtml(html.result.value,id);if(post)parts.push(post);}
        }
        const result=media.mergeParts(parts);if(!result.inventoryKnown){report({phase:'inventory-unavailable',responseCount:parts.length,receivedBytes:bytes});throw Error('SNS_X_BROWSER_CONTENT_UNAVAILABLE');}
        return result;
    } finally {
        clearTimeout(hardStop);
        if(protocol)await protocol.send('Browser.close').catch(()=>{});protocol?.close();
        if(child && child.exitCode===null)stop();
        if(done)await Promise.race([done,new Promise(resolve=>setTimeout(resolve,2000))]);
        process.removeListener('exit',stop);
        busy=false;
        if(profile && path.dirname(profile)===path.resolve(os.tmpdir()) && path.basename(profile).startsWith('tunnel-x-reader-'))fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    }
}
module.exports={readBrowserPost,findBrowserBinary,allowedRequest,connectDevTools};
