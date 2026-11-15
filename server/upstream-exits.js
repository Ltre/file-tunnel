'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');

const SERVICES = ['telegram','youtube','twitter','facebook','line','instagram','tiktok','bilibili','netease','other'];
const clone = value => JSON.parse(JSON.stringify(value));
function serviceFor(value) {
    let host; try { host = new URL(value).hostname.toLowerCase(); } catch (_) { return 'other'; }
    const is = domain => host === domain || host.endsWith('.' + domain);
    if (['telegram.org','t.me','telegram.me'].some(is)) return 'telegram';
    if (['youtube.com','youtu.be','googlevideo.com','ytimg.com','ggpht.com'].some(is)) return 'youtube';
    if (['x.com','twitter.com','twimg.com'].some(is)) return 'twitter';
    if (['facebook.com','fb.watch','fbcdn.net'].some(is)) return 'facebook';
    if (['line.me','line-apps.com'].some(is)) return 'line';
    if (['instagram.com','cdninstagram.com','threads.net','threads.com'].some(is)) return 'instagram';
    if (['tiktok.com','tiktokcdn.com','tiktokv.com'].some(is)) return 'tiktok';
    if (['bilibili.com','b23.tv','bilivideo.com','hdslb.com'].some(is)) return 'bilibili';
    if (['163.com','126.net','163cn.tv','163cn.link'].some(is)) return 'netease';
    return 'other';
}

function createUpstreamExits({ dataDir, root = path.resolve(__dirname, '..'), idleMs = 30000, startRuntime, nativeFetch = global.fetch } = {}) {
    const filename = path.join(dataDir, 'upstream-exits.json');
    let config = { nodes: [], services: {} }, closed = false;
    if (fs.existsSync(filename)) {
        config = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (!Array.isArray(config.nodes) || !config.services || typeof config.services !== 'object') throw Error('出口配置文件无效');
    }
    const storage = new AsyncLocalStorage(), runtimes = new Map(), tickets = new Map();
    const write = () => {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        const temp = filename + '.' + crypto.randomUUID() + '.tmp';
        try { fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temp, filename); }
        finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
        try { fs.chmodSync(filename, 0o600); } catch (_) {}
    };
    const clean = (value, max = 200) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
    const publicNode = node => Object.fromEntries(['id','name','server','port','serverName','verifyTls','remark','revision'].map(key=>[key,node[key]]).concat([['hasPassword',Boolean(node.password)]]));
    function publicConfig() {
        return { nodes: config.nodes.map(publicNode), services: SERVICES.map(id => ({ id, configured: Boolean(config.services[id]),
            defaultExit: 'direct', mode: 'ordered', order: [], includeDirect: false, revision: 0, ...config.services[id] })),
            runtimes: [...runtimes.values()].map(r => ({ name: r.node.name, running: Boolean(r.worker?.alive()), starting: !r.worker && Boolean(r.starting), activeTasks: r.refs })) };
    }
    function saveNode(id, input) {
        const previous = id ? config.nodes.find(n => n.id === id) : null;
        if (id && !previous) throw Error('节点不存在，请刷新列表');
        if (previous && Number(input.revision) !== previous.revision) throw Error('节点已被其他操作修改，请刷新后重试');
        const node = { id: previous?.id || crypto.randomUUID(), name: clean(input.name), server: clean(input.server, 253),
            port: Number(input.port), password: input.password === undefined || input.password === '' ? previous?.password || '' : String(input.password),
            serverName: clean(input.serverName, 253), verifyTls: input.verifyTls !== false, remark: clean(input.remark, 2000), revision: (previous?.revision || 0) + 1 };
        if (!node.name || !node.server || /[\s/\\]/.test(node.server) || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535 ||
            !node.password || node.password.length > 4096 || /[\r\n\0]/.test(node.password)) throw Error('请填写节点名称、有效地址、端口及 Trojan 密码');
        const before = config; config = clone(config);
        if (previous) config.nodes[config.nodes.findIndex(n => n.id === id)] = node; else config.nodes.push(node);
        try { write(); } catch (error) { config = before; throw error; }
        return publicNode(node);
    }
    function deleteNode(id) {
        if (!config.nodes.some(n => n.id === id)) throw Error('节点不存在，请刷新列表');
        const before = config; config = clone(config); config.nodes = config.nodes.filter(n => n.id !== id);
        for (const item of Object.values(config.services)) { if (item.defaultExit === id) item.defaultExit = 'direct'; item.order = item.order.filter(value => value !== id); item.revision++; }
        try { write(); } catch (error) { config = before; throw error; }
    }
    function saveService(id, input) {
        if (!SERVICES.includes(id)) throw Error('未知上游服务');
        const previous = config.services[id];
        if (Number(input.revision || 0) !== (previous?.revision || 0)) throw Error('服务设置已被其他操作修改，请刷新后重试');
        const ids = new Set(['direct', ...config.nodes.map(n => n.id)]);
        if (!ids.has(input.defaultExit) || !['random','ordered'].includes(input.mode)) throw Error('请选择有效的默认出口和轮询方式');
        const order = [...new Set(Array.isArray(input.order) ? input.order : [])];
        if (order.some(value => !ids.has(value))) throw Error('候选顺序包含已删除的节点，请刷新后重试');
        const before = config; config = clone(config);
        config.services[id] = { defaultExit: input.defaultExit, mode: input.mode, order, includeDirect: input.includeDirect === true, revision: (previous?.revision || 0) + 1 };
        try { write(); } catch (error) { config = before; throw error; }
        return publicConfig().services.find(item => item.id === id);
    }
    async function nativeRuntime(node) {
        if (closed) throw Error('出口组件正在关闭');
        const binary = path.join(root, 'tools', 'sing-box', process.platform === 'win32' ? 'win-x64/sing-box.exe' : 'linux-x64/sing-box');
        if (!fs.existsSync(binary)) throw Error('sing-box 组件不存在，请检查 tools/sing-box 对应平台目录');
        const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0,'127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); });
        const dir = path.join(dataDir, 'upstream-runtime'); fs.mkdirSync(dir,{ recursive:true,mode:0o700 });
        const runtimeFile = path.join(dir, crypto.randomUUID() + '.json');
        fs.writeFileSync(runtimeFile, JSON.stringify({ log: { level:'error' }, inbounds: [{ type:'http', tag:'local', listen:'127.0.0.1', listen_port:port }],
            outbounds:[{ type:'trojan', tag:'selected', server:node.server, server_port:node.port, password:node.password,
                tls:{ enabled:true, server_name:node.serverName || node.server, insecure:!node.verifyTls } }], route:{ final:'selected' } }), { mode:0o600 });
        const child = spawn(binary,['run','-c',runtimeFile],{ windowsHide:true,stdio:['ignore','ignore','pipe'] });
        let exited = false, lastError = '', stopped = false;
        child.stderr.on('data', chunk => { lastError = (lastError + chunk.toString()).slice(-2000).split(node.password).join('[hidden]'); });
        child.on('error', () => { exited = true; });
        child.on('exit', () => { exited = true; try { fs.unlinkSync(runtimeFile); } catch (_) {} });
        const stop = () => { if (stopped) return; stopped=true; child.kill(); };
        try {
            const deadline = Date.now() + 8000;
            while (true) {
                if (exited) throw Error('sing-box 启动失败：' + (lastError || '进程已退出'));
                const ready = await new Promise(resolve => { const socket = net.connect(port,'127.0.0.1'); socket.setTimeout(150); socket.once('connect',()=>{socket.destroy();resolve(true);}); socket.once('error',()=>resolve(false)); socket.once('timeout',()=>{socket.destroy();resolve(false);}); });
                if (ready) break;
                if (Date.now() >= deadline) throw Error('sing-box 本地入口启动超时');
                await new Promise(resolve => setTimeout(resolve,40));
            }
        } catch (error) { stop(); try { fs.unlinkSync(runtimeFile); } catch (_) {} throw error; }
        return { proxy:'http://127.0.0.1:' + port, stop, alive:()=>!exited, error:()=>lastError };
    }
    async function acquire(node) {
        const key = crypto.createHash('sha256').update(JSON.stringify(node)).digest('hex');
        let runtime = runtimes.get(key);
        if (runtime?.worker && !runtime.worker.alive()) { runtimes.delete(key); runtime = null; }
        if (!runtime) { runtime = { node:clone(node),refs:0 }; runtimes.set(key,runtime); runtime.starting = Promise.resolve().then(() => (startRuntime || nativeRuntime)(node)).then(worker => runtime.worker=worker).catch(error=>{ if(runtimes.get(key)===runtime)runtimes.delete(key);throw error; }); }
        runtime.refs++; clearTimeout(runtime.timer);
        try { await runtime.starting; } catch (error) { runtime.refs--; throw error; }
        let released = false;
        return { proxy:runtime.worker.proxy, error:()=>runtime.worker.error?.() || '', release() {
            if (released) return; released=true; runtime.refs--;
            if (!runtime.refs) { runtime.timer=setTimeout(()=>{ if(!runtime.refs && runtimes.get(key)===runtime){runtimes.delete(key);runtime.worker.stop();} },idleMs); runtime.timer.unref?.(); }
        } };
    }
    function context(url, requested, onChange = () => {}, ticket) {
        const saved = ticket && tickets.get(ticket);
        if (saved && saved.expires > Date.now() && saved.url === url && saved.requested === (requested || '')) {
            return { ...saved.context, lease:null, dispatcher:null, attempts:[...saved.context.attempts], onChange, inContent:false, closed:false };
        }
        const snapshot = clone(config), service = serviceFor(url), policy = snapshot.services[service];
        return { url,service,snapshot,policy,requested:requested || '', managed:Boolean(policy || requested), selected:null,locked:false,attempts:[],onChange,lease:null,dispatcher:null,inContent:false,closed:false };
    }
    const summary = ctx => ({ service:ctx.service, selected:ctx.selected ? { id:ctx.selected.id,name:ctx.selected.name } : null, locked:ctx.locked,
        attempts:ctx.attempts.map(item => ({ ...item })) });
    function changed(ctx) { ctx.onChange(summary(ctx)); }
    async function release(ctx) { if(ctx.closed)return;ctx.closed=true;try{await ctx.dispatcher?.close();}finally{ctx.lease?.release();ctx.dispatcher=null;ctx.lease=null;} }
    function order(ctx) {
        const policy = ctx.policy || {defaultExit:'direct',mode:'ordered',includeDirect:false,order:[]};
        const first = ctx.requested || policy.defaultExit;
        if(first !== 'direct' && !ctx.snapshot.nodes.some(n=>n.id===first))throw Error('指定出口节点不存在，请重新选择');
        const allowed = [...ctx.snapshot.nodes.map(n=>n.id),...(policy.includeDirect?['direct']:[])];
        let others = [...new Set([...(policy.order || []),...allowed])].filter(id=>id!==first && allowed.includes(id));
        if(policy.mode==='random')for(let i=others.length-1;i>0;i--){const j=crypto.randomInt(i+1);[others[i],others[j]]=[others[j],others[i]];}
        return [first,...others];
    }
    async function select(ctx,id) {
        if(ctx.dispatcher)await ctx.dispatcher.destroy();ctx.dispatcher=null;ctx.lease?.release();ctx.lease=null;
        ctx.closed=false;ctx.hadNetwork=false;ctx.commandOutput=''; ctx.selected = id==='direct'?{id:'direct',name:'本机直连'}:ctx.snapshot.nodes.find(n=>n.id===id);
        const item={id,name:ctx.selected.name,status:'trying',at:Date.now()};ctx.attempts.push(item);changed(ctx);
    }
    async function transport(ctx) {
        if(!ctx.selected)await select(ctx,order(ctx)[0]);
        if(!ctx.lease && ctx.selected.id!=='direct')ctx.lease=await acquire(ctx.selected);
        if(!ctx.dispatcher){const {Agent,ProxyAgent}=require('undici');ctx.dispatcher=ctx.lease?new ProxyAgent(ctx.lease.proxy):new Agent();}
        return ctx.dispatcher;
    }
    const valid = value => Boolean(value && typeof value==='object' && (value.id || value.title || value.entries?.length || value.url || value.selection));
    async function content(url, work, validate = valid) {
        const current=storage.getStore();
        if(!current)return withContext(context(url),()=>content(url,work,validate));
        if(!current.managed || current.inContent)return work();
        if(current.initialError)throw current.initialError;
        if(current.locked){await transport(current);return work();}
        const candidates=current.selected?[current.selected.id,...order(current).filter(id=>id!==current.selected.id)]:order(current);
        let last;
        for(const id of candidates){
            try{
                if(current.selected?.id!==id)await select(current,id);
                current.inContent=true;
                const value=await work();
                if(!validate(value) || (current.requireFormats && !value?.formats?.length)){
                    const error=Error('该出口未取得任务所需的有效内容');
                    if(typeof value?.status==='number' && typeof value?.body?.cancel==='function'){
                        error.upstreamResponse=value;
                        if(id!==candidates.at(-1))await value.body.cancel().catch(()=>{});
                    }
                    throw error;
                }
                current.locked=Boolean(current.hadNetwork);current.attempts.at(-1).status=current.locked?'success':'cached';changed(current);return value;
            }catch(error){last=error;if(current.locked)throw error;if(current.attempts.length){current.attempts.at(-1).status='failed';current.attempts.at(-1).error=clean(String(error.message).split(current.selected?.password || '\0').join('[hidden]'),500);changed(current);}if(error.name==='AbortError'||/cancelled|canceled/i.test(error.message))throw error;}
            finally{current.inContent=false;}
        }
        // Preserve the final HTTP response for the original business decoder
        // (e.g. Telegram's 429/retry_after), rather than replacing its error.
        if(last?.upstreamResponse)return last.upstreamResponse;
        throw last || Error('没有可用出口');
    }
    async function withContext(ctx,work){return storage.run(ctx,async()=>{
        let streaming=false;
        try{const value=await work();if(value && typeof value.pipe==='function' && typeof value.once==='function'){
            streaming=true;const finish=()=>{release(ctx).catch(()=>{});};
            value.once('end',finish);value.once('close',finish);value.once('error',finish);if(value.destroyed||value.readableEnded)finish();
        }return value;}finally{if(!streaming)await release(ctx);}
    });}
    function serviceScope(service,work){
        if(storage.getStore()?.service===service)return work();
        const ctx=context('https://upstream.invalid');ctx.service=service;ctx.policy=ctx.snapshot.services[service];ctx.managed=Boolean(ctx.policy);
        return withContext(ctx,work);
    }
    function wrapService(service,target){
        const wrapped=new Map();
        return new Proxy(target,{get(object,key){const value=Reflect.get(object,key,object);if(typeof value!=='function')return value;
            if(!wrapped.has(key))wrapped.set(key,function(...args){return serviceScope(service,()=>{
                const work=()=>Reflect.apply(value,object,args);
                return ['readPart','prefetchPartLocation'].includes(key) || key==='call' && /^get[A-Z]/.test(String(args[1]||''))
                    ? content('https://upstream.invalid',work,()=>true) : work();
            });});return wrapped.get(key);
        }});
    }
    function runTask(task,work,onChange){
        const ctx=context(task.url,task.networkExit,onChange,task.networkTicket);
        if(task.networkRoute?.locked && task.networkRoute.selected){
            const selected=task.networkRoute.selected;
            ctx.managed=true;ctx.locked=true;ctx.attempts=clone(task.networkRoute.attempts || []);
            ctx.selected=selected.id==='direct'?{id:'direct',name:selected.name}:ctx.snapshot.nodes.find(node=>node.id===selected.id);
            if(!ctx.selected)ctx.initialError=Error('此任务原先采用的出口节点已删除，不能自动更换出口');
        }
        return withContext(ctx,work);
    }
    async function routedFetch(input,init){
        const url=typeof input==='string'||input instanceof URL?String(input):input.url;
        const ctx=storage.getStore();
        if(ctx){if(!ctx.managed)return nativeFetch(input,init);ctx.hadNetwork=true;return nativeFetch(input,{...init,dispatcher:await transport(ctx)});}
        if(!config.services[serviceFor(url)])return nativeFetch(input,init);
        // Standalone HTTP consumers keep the component leased until the body ends.
        const own=context(url);return storage.run(own,async()=>{
            try{
                const method=String(init?.method || input?.method || 'GET').toUpperCase();
                const readOnly=['GET','HEAD'].includes(method) || own.service==='telegram' && /^get[A-Z]/.test(new URL(url).pathname.split('/').at(-1));
                // Never replay an upload/other write. The original caller retains
                // its existing requestNotAccepted, body factory and retry rules.
                const response=readOnly?await content(url,()=>routedFetch(input,init),response=>response.ok):await routedFetch(input,init);
                if(!response.body){await release(own);return response;}
                const reader=response.body.getReader();
                const stream=new ReadableStream({async pull(controller){try{const part=await reader.read();if(part.done){controller.close();await release(own);}else controller.enqueue(part.value);}catch(error){controller.error(error);await release(own);}},async cancel(reason){try{await reader.cancel(reason);}finally{await release(own);}}});
                const result=new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
                Object.defineProperty(result,'url',{value:response.url});return result;
            }catch(error){await release(own);throw error;}
        });
    }
    function cliArgs(args){const ctx=storage.getStore();if(!ctx?.managed || !ctx.selected)return args;return ['--proxy',ctx.lease?.proxy || '',...args];}
    function requestScope(req,res,next){
        const url=String(req.body?.url || ''),requested=clean(req.body?.networkExit,80);
        const ctx=context(url,requested,()=>{},req.body?.networkTicket);
        ctx.requireFormats=true;
        const json=res.json.bind(res);
        res.json=data=>{
            if(data && typeof data==='object' && !data.error && ctx.selected){
                if(tickets.size>=256)tickets.delete(tickets.keys().next().value);
                const token=crypto.randomUUID();tickets.set(token,{url,requested,expires:Date.now()+30*60000,context:{...ctx,snapshot:clone(ctx.snapshot),onChange:()=>{},lease:null,dispatcher:null}});
                data={...data,networkRoute:summary(ctx),networkTicket:token};
            }
            return json(data);
        };
        res.once('finish',()=>{release(ctx).catch(()=>{});});res.once('close',()=>{release(ctx).catch(()=>{});});
        return storage.run(ctx,next);
    }
    async function publicProxy(url,work){const ctx=storage.getStore();if(!ctx)return withContext(context(url),()=>publicProxy(url,work));if(!ctx.managed)return work(undefined);return content(url,async()=>{await transport(ctx);ctx.hadNetwork=true;return work(ctx.lease?.proxy || '');},()=>true);}
    function observeCommand(chunk){
        const ctx=storage.getStore();if(!ctx?.managed || ctx.locked)return;
        ctx.commandOutput=((ctx.commandOutput || '')+String(chunk)).slice(-16384);
        // Observe existing output only: retain every yt-dlp argument and its
        // original progress parser. Cached format data alone cannot prove that
        // the current outlet can obtain the task's actual formats/content.
        if(/\[info\][^\r\n]*Downloading \d+ format\(s\):|\[download\]\s+(?:100(?:\.0+)?|[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)%|\[download\][^\r\n]*\bat\s+(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)\s*[KMGT]?i?B\/s/i.test(ctx.commandOutput)){
            ctx.locked=true;ctx.hadNetwork=true;if(ctx.attempts.length)ctx.attempts.at(-1).status='success';changed(ctx);
        }
    }
    async function testPage(value,id,{captureBody=false}={}){
        let url;try{url=new URL(String(value || '').trim());}catch(_){throw Error('请填写有效的 HTTP 或 HTTPS 页面地址');}
        if(!['http:','https:'].includes(url.protocol) || url.username || url.password)throw Error('测试地址须为不含账号密码的 HTTP 或 HTTPS 地址');
        if(id!=='direct' && !config.nodes.some(node=>node.id===id))throw Error('测试出口不存在，请重新选择');
        const ctx=context(url.href,id);ctx.managed=true;
        return withContext(ctx,async()=>{
            const started=performance.now();await select(ctx,id);ctx.locked=true;
            try{
                const response=await routedFetch(url.href,{signal:AbortSignal.timeout(captureBody?15000:25000),redirect:'follow'});
                const reader=response.body?.getReader();let bytes=0,truncated=false;const body=[];
                if(reader)try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(captureBody)body.push(part.value);if(bytes>=(captureBody?1024:256*1024)){truncated=true;break;}}}finally{await reader.cancel().catch(()=>{});}
                return {exitName:ctx.selected.name,finalUrl:response.url || url.href,httpStatus:response.status,statusText:response.statusText,ok:response.ok,durationMs:Math.round(performance.now()-started),checkedBytes:bytes,truncated,...(captureBody?{bodyText:Buffer.concat(body).toString('utf8')}: {})};
            }catch(error){let message=[error.message,error.cause?.code,error.cause?.message,ctx.lease?.error()].filter(Boolean).join(' · ').slice(0,2000);for(const node of config.nodes)message=message.split(node.password).join('[hidden]');throw Error('节点“'+ctx.selected.name+'”测试失败：'+message);}
        });
    }
    async function confirmExit(id){
        const result=await testPage('https://api.ipify.org',id,{captureBody:true}),ip=result.bodyText.trim();
        if(!result.ok || result.truncated || !net.isIP(ip))throw Error('出口确认未取得有效 IP 地址（HTTP '+result.httpStatus+'），请重试');
        return {exitName:result.exitName,ip,family:net.isIP(ip),durationMs:result.durationMs};
    }
    async function close(){closed=true;for(const runtime of runtimes.values()){clearTimeout(runtime.timer);try{(runtime.worker||await runtime.starting)?.stop();}catch(_){}}runtimes.clear();tickets.clear();}
    return { publicConfig,saveNode,deleteNode,saveService,content,runTask,requestScope,fetch:routedFetch,cliArgs,publicProxy,testPage,confirmExit,serviceScope,wrapService,observeCommand,
        scope(url,work){return storage.getStore()?work():withContext(context(url),work);},
        ready(){const ctx=storage.getStore();if(ctx?.initialError)return Promise.reject(ctx.initialError);if(ctx?.managed){ctx.hadNetwork=true;return transport(ctx);}return Promise.resolve();},
        current:()=>storage.getStore(),close,serviceFor,installFetch(){global.fetch=routedFetch;},restoreFetch(){if(global.fetch===routedFetch)global.fetch=nativeFetch;} };
}
module.exports={createUpstreamExits,SERVICES,serviceFor};
