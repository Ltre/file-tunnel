'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{execFile}=require('node:child_process');
const {WebSocketServer}=require('ws');
const {connectDevTools}=require('../server/twitter-post-browser');

test('local browser control stays direct when Node global proxy is enabled and NO_PROXY is empty',async t=>{
    let proxyRequests=0;
    const proxy=http.createServer((_req,res)=>{proxyRequests++;res.writeHead(502);res.end();});proxy.on('connect',(_req,socket)=>{proxyRequests++;socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');});
    await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{proxy.closeAllConnections();proxy.close(resolve);}));
    const server=http.createServer(),websocket=new WebSocketServer({server});
    websocket.on('connection',socket=>socket.on('message',data=>{const request=JSON.parse(String(data));socket.send(JSON.stringify({id:request.id,result:{ok:true}}));}));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{for(const socket of websocket.clients)socket.terminate();websocket.close(()=>server.close(resolve));}));
    const endpoint='ws://127.0.0.1:'+server.address().port+'/devtools/browser/fixture',proxyUrl='http://127.0.0.1:'+proxy.address().port;
    const code=`const {connectDevTools}=require(${JSON.stringify(require.resolve('../server/twitter-post-browser'))});(async()=>{const c=await connectDevTools(${JSON.stringify(endpoint)});try{console.log(JSON.stringify(await c.send('Browser.getVersion')))}finally{c.close()}})().catch(e=>{console.error(e.message);process.exitCode=1})`;
    const result=await new Promise((resolve,reject)=>execFile(process.execPath,['-e',code],{encoding:'utf8',timeout:10000,windowsHide:true,env:{...process.env,NODE_USE_ENV_PROXY:'1',HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,NO_PROXY:'',http_proxy:proxyUrl,https_proxy:proxyUrl,no_proxy:''}},(error,stdout,stderr)=>error?reject(Error(stderr||error.message)):resolve(stdout)));
    assert.equal(JSON.parse(result).ok,true);assert.equal(proxyRequests,0);
});

test('browser-control transport never connects to an external or credential-bearing endpoint',async()=>{
    for(const endpoint of ['ws://10.0.0.9:9000/','wss://x.com/','ws://user:secret@127.0.0.1:9000/'])await assert.rejects(connectDevTools(endpoint),/SNS_X_BROWSER_CONNECT_FAILED/);
});
