'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express'),vm=require('node:vm');
const {chromium}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const part=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
test('restore metadata preserves the latest real IndexedDB content; explicit cache clearing still removes it',async t=>{
 const app=express();app.get('/',(_q,res)=>res.type('html').send('<script>const state={},memoryStorage=new Map(),fileCacheStore=null;'+
 part('function getBinaryDataSize(','async function initFileCacheStore(')+part('async function saveToStore(','async function getAllFromStore(')+
 'window.ready=new Promise((resolve,reject)=>{const request=indexedDB.open("isolated-cache",1);request.onupgradeneeded=()=>request.result.createObjectStore("files",{keyPath:"id"});request.onsuccess=()=>{state.db=request.result;resolve();};request.onerror=()=>reject(request.error);});</script>'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
 const result=await page.evaluate(async()=>{
  await ready;const complete={id:'file',size:4,data:Uint8Array.of(1,2,3,4).buffer};
  const restore={id:'file',size:4,cacheCleared:true,restoreRequested:true};
  await Promise.all([saveToStore('files',complete),saveToStore('files',restore)]);
  const a=await getFromStore('files','file');
  await saveToStore('files',{...restore,data:undefined});const b=await getFromStore('files','file');
  let failure;try{await saveToStore('files',{...restore,uncloneable:()=>{}});}catch(error){failure=error.name;}
  const afterFailure=await getFromStore('files','file');
  await saveToStore('files',{id:'file',size:4,cacheCleared:true},{clearFileCache:true});const cleared=await getFromStore('files','file');
  return {a:[...new Uint8Array(a.data)],b:[...new Uint8Array(b.data)],restoring:a.restoreRequested,failure,failureBytes:afterFailure.data.byteLength,cleared:!cleared.data&&cleared.cacheCleared};
 });
 assert.deepEqual(result,{a:[1,2,3,4],b:[1,2,3,4],restoring:false,failure:'DataCloneError',failureBytes:4,cleared:true});
});
test('LAN registration reads the address field after ICE priority, while mDNS stays undisclosed',async()=>{
 for(const [address,expected] of [['10.0.0.21','10.0.0.21'],['192.168.1.7','192.168.1.7'],['fd12::1','fd12::1'],['hidden.local',null],['8.8.8.8',null]]){
  const context={setTimeout,clearTimeout};context.window={RTCPeerConnection:class{createDataChannel(){}createOffer(){return Promise.resolve({});}setLocalDescription(){this.onicecandidate({candidate:{candidate:'candidate:1234 1 udp 2122260223 '+address+' 53452 typ host generation 0'}});this.onicecandidate({candidate:null});return Promise.resolve();}close(){}}};
  context.RTCPeerConnection=context.window.RTCPeerConnection;
  vm.runInNewContext(part('function isPrivateNetworkIp(','let qrCodeLibraryPromise'),context);
  assert.equal(await context.discoverLocalNetworkIp(),expected);
 }
});
