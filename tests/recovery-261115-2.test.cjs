'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const media=require('../server/twitter-post-media');
function receiver(){const context={window:{},setInterval:()=>0,setTimeout,clearTimeout,console};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../client/file-assets.js'),'utf8'),context);const value=new context.window.FileAssetTransfer({log:()=>{},getSocket:()=>null,getSessionId:()=> 'fixture',load:async()=>null,onProgress:()=>{}});value.desiredAssets.set('file',true);return value;}
test('a playable embed video without an entity ID satisfies its own focal-post inventory',()=>{
 const post=media.fromPost({id_str:'123',mediaDetails:[{type:'video',video_info:{variants:[{url:'https://video.twimg.com/amplify_video/456/vid/avc1/1280x720/test.mp4',content_type:'video/mp4'}]}}]},'123');
 assert.equal(post.videoMetas.length,1);assert.deepEqual(media.missingVideos(post,post.videoMetas),[]);
});
test('a late relay start for a finished or superseded range is refused as stale before metadata initialization',async()=>{
 const value=receiver(),range={transferId:'part',rangeStart:0,rangeEnd:10,active:false,completed:true};
 value.multiSourceTransfers.set('file',{ranges:new Map([['part',range]])});
 const result=await value.handleRelayStart({asset:{id:'file',size:10},from:'peer',attemptId:'attempt',transfer:{transferId:'part',rangeStart:0,rangeEnd:10}});
 assert.equal(result.ok,false);assert.equal(result.reason,'receiver-stale-request');
 range.active=true;range.completed=false;range.requestId='req-current';
 assert.equal(value.shouldAcceptIncomingTransfer('file',{id:'file'},'req-previous-p2p-part','part').reason,'stale-request');
 assert.equal(value.shouldAcceptIncomingTransfer('file',{id:'file'},'req-current-relay-part','part').ok,true);
 range.requestId='req-current-forced-'+('restore-token-'.repeat(20));
 assert.equal(value.shouldAcceptIncomingTransfer('file',{id:'file'},range.requestId.slice(0,120),'part').ok,true,'forced restore identities retain the original 120-character wire limit');
});
test('valid active range boundaries are still checked instead of suppressing malformed metadata',()=>{
 const value=receiver(),range={transferId:'part',active:true,rangeStart:0,rangeEnd:10};value.multiSourceTransfers.set('file',{ranges:new Map([['part',range]])});
 assert.throws(()=>value.beginMultiSourceRange('file',{id:'file'},'peer','p2p',{transferId:'part',rangeStart:1,rangeEnd:10},'attempt'),/Invalid multi-source range metadata/);
});
test('restored multi-source progress stays grouped by file instead of adding a row for every range',()=>{
 const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),body=app.slice(app.indexOf('function getFileProgressKey('),app.indexOf('function getProgressBaseFileId('));
 const key=vm.runInNewContext(body+';getFileProgressKey');
 assert.equal(key('file','sending-multi-source:peer:part-a'),key('file','sending-multi-source:peer:part-b'));
 assert.equal(key('file','sending-multi-source:peer:part-a'),key('file','sending-multi-source-relay:peer:part-a'));
 assert.notEqual(key('file','sending-multi-source:peer:part-a'),key('file','sending-multi-source:other:part-a'));
 assert.equal(key('file','receiving-multi-source'),'file');
});
test('the last-resort X browser uses the same selected outlet as the metadata task',async t=>{
 const os=require('node:os'),posts=require('../server/sns-post-markdown'),{createUpstreamExits}=require('../server/upstream-exits'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'x-outlet-test-'));
 const exits=createUpstreamExits({dataDir:dir,log:()=>{},startRuntime:async()=>({proxy:'http://127.0.0.1:50123',alive:()=>true,stop(){}})});
 t.after(async()=>{posts.setUpstreamAdapter(undefined);await exits.close();fs.rmSync(dir,{recursive:true,force:true});});
 const node=exits.saveNode(null,{name:'selected',server:'fixture.invalid',port:443,password:'synthetic'});exits.saveService('twitter',{defaultExit:node.id,mode:'ordered',order:[],includeDirect:false,revision:0});posts.setUpstreamAdapter(exits);
 let used;
 const result=await exits.runTask({url:'https://x.com/fixture/status/123'},()=>exits.content('https://x.com/fixture/status/123',()=>posts.inspectSnsPost({sourceUrl:'https://x.com/fixture/status/123'},{runMetadata:async()=>({_type:'video',id:'123',formats:[]}),request:async()=>{throw Error('public reader unavailable');},readBrowserPost:async(_url,options)=>{used=options.proxy;return media.fromPost({id_str:'123',mediaDetails:[{type:'video',video_info:{variants:[{url:'https://video.twimg.com/amplify_video/456/vid/test.mp4',content_type:'video/mp4'}]}}]},'123');}}),value=>value.mediaComplete));
 assert.equal(used,'http://127.0.0.1:50123');assert.equal(result.mediaComplete,true);
});
