'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function harness(){
 const c={window:{},ArrayBuffer,Uint8Array,Blob,setInterval:()=>0,setTimeout,clearTimeout};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../client/file-assets.js'),'utf8'),c);
 const progress=[],transfer=new c.window.FileAssetTransfer({onProgress:(...args)=>progress.push(args),log(){}});
 vm.runInNewContext(source.slice(source.indexOf('function getFileProgressStatus('),source.indexOf('function trackFileReceiveProgress(')),c);
 return{transfer,progress,label:c.getFileProgressStatus};
}
function state(routes){return{asset:{id:'file',name:'test.bin',size:100},completedBytes:0,ranges:new Map(routes.map((route,i)=>['p'+i,{from:'provider-'+i,transport:route,active:true,receivedSize:10,completed:false,retryScheduled:false}]))};}
test('Relay-only receiving ranges are not labeled P2P, and actual mixed ranges are distinguished',()=>{
 const h=harness();h.transfer.reportMultiSourceProgress(state(['socket-relay','socket-relay']));assert.equal(h.progress.at(-1)[2],20);assert.equal(h.label(h.progress.at(-1)[3]),'multi-source Socket.IO relay');
 h.transfer.reportMultiSourceProgress(state(['p2p','p2p']));assert.equal(h.label(h.progress.at(-1)[3]),'multi-source P2P');
 h.transfer.reportMultiSourceProgress(state(['p2p','socket-relay']));assert.equal(h.label(h.progress.at(-1)[3]),'multi-source P2P / Socket.IO relay');
});
test('waiting manifests create no receiving row; completed or abandoned routes do not mislabel a live range',()=>{
 const h=harness(),s=state([null,null]);for(const r of s.ranges.values()){r.active=false;r.from=null;r.receivedSize=0;}
 h.transfer.reportMultiSourceProgress(s);assert.equal(h.progress.length,0);
 s.ranges.get('p0').transport='p2p';s.ranges.get('p0').completed=true;
 Object.assign(s.ranges.get('p1'),{active:true,from:'provider',transport:'socket-relay'});h.transfer.reportMultiSourceProgress(s);assert.equal(h.label(h.progress.at(-1)[3]),'multi-source Socket.IO relay');
 Object.assign(s.ranges.get('p0'),{completed:false,active:true,from:'old-provider',retryScheduled:true,transport:'p2p'});h.transfer.reportMultiSourceProgress(s);assert.equal(h.label(h.progress.at(-1)[3]),'multi-source Socket.IO relay');
});
