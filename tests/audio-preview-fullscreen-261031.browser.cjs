'use strict';
// Production preview/fullscreen functions and real browser audio elements.
// A local sine wave replaces personal files; Audio() objects are also tracked
// because the preview's audio can be detached from the document.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), express = require('express');
const {chromium} = require(process.argv[2] || path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const root=path.resolve(__dirname,'..'), source=fs.readFileSync(path.join(root,'app.js'),'utf8');
const block=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
function wave(){const samples=16000*20, data=Buffer.alloc(44+samples*2);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(16000,24);data.writeUInt32LE(32000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)data.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/16000)*12000),44+i*2);return data;}
(async()=>{
 const app=express(), body=wave();app.use('/client',express.static(path.join(root,'client')));app.get('/tone.wav',(req,res)=>{
  res.type('audio/wav').set('Accept-Ranges','bytes');const range=/^bytes=(\d+)-(\d*)$/.exec(req.get('range')||'');
  if(!range)return res.send(body);const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),body.length-1):body.length-1;
  if(start>=body.length)return res.status(416).set('Content-Range','bytes */'+body.length).end();
  res.status(206).set('Content-Range',`bytes ${start}-${end}/${body.length}`).send(body.subarray(start,end+1));
 });
 const functions=[block('function getPreviewMediaNaturalSize(', '\nfunction renderFilePreviewLoading('),block('function getAudioForPreviewControls(', '\nasync function activateMusicTrack('),block('function pauseBackgroundForTemporaryPreview(', '\nasync function openFilePreviewForInfo('),block('async function getFullscreenPreviewItems(', '\nfunction getRemotePreviewFullscreenState('),block('function navigateMediaFullscreen(', '\nasync function getCollectionPreviewNavigationFiles(')].join('\n');
 const html=fs.readFileSync(path.join(root,'pages/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
 app.get('/audio-check',(_req,res)=>res.type('html').send(html.replace('</body>',`<script>
 document.getElementById('tunnelStartupLoading').remove();
 const audios=new Set(),NativeAudio=window.Audio;window.Audio=function(...args){const audio=new NativeAudio(...args);audios.add(audio);return audio;};
 const musicPlayer={queue:[],tempAudio:null,tempPreviewFileId:'',tempResumeBackground:false,previewControls:null},state={sessionId:'fixture'};
 const activeFilePreviewStoredFile={id:'tone',name:'tone.wav',type:'audio/wav',data:new Blob(['fixture']),audioPoster:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'};
 const activeFilePreviewFileId='tone',activeFilePreviewCanFullscreen=true,activeFilePreviewMediaType='audio/wav',activeFilePreviewMessageId='record-tone',activeCollectionPreviewMessageId='',activeFilePreviewObjectUrl='/tone.wav';
 let mediaFullscreenItems=[],mediaFullscreenIndex=0,mediaFullscreenLoadVersion=0,mediaFullscreenHistoryOpen=false,mediaFullscreenMovedMedia=null,mediaFullscreenMovedParent=null,mediaFullscreenMovedNextSibling=null,mediaFullscreenMovedPlaceholder=null;
 let mediaFullscreenZoom={scale:1,x:0,y:0},mediaFullscreenPointerStart=null,mediaFullscreenGesture={pointers:new Map(),pinch:false},mediaFullscreenMousePan=null,mediaFullscreenSuppressClickUntil=0,activeRemotePreviewControl=null,suppressNextFilePreviewPopstate=false;
 const MEDIA_FULLSCREEN_HISTORY_KEY='fixture-fullscreen';
 const historyLog=()=>{},scheduleFileObjectUrlCleanup=()=>{},getCachedMediaPosterOrQueue=()=>'',getCurrentMusicTrack=()=>null,isBackgroundMusicPlaying=()=>false,showAppToast=()=>{},getStoredFileUrl=()=>'/tone.wav';
 const setFilePreviewContentStage=value=>{const node=document.getElementById('filePreviewContent');node.className='file-preview-content '+value;return node;},escapeHtml=value=>String(value).replace(/[&<>"']/g,''),formatAudioTime=value=>String(Math.floor(value)),isFullscreenPreviewableType=type=>/^(video|audio|image)\\//.test(type),hasCompleteFileCache=()=>true;
 ${functions}
 document.getElementById('filePreviewViewer').classList.add('active');
 renderAudioPreview(document.getElementById('filePreviewContent'),{id:'tone',name:'tone.wav'},activeFilePreviewStoredFile,'/tone.wav');
 document.getElementById('filePreviewFullscreenBtn').hidden=false;
 document.getElementById('filePreviewFullscreenBtn').onclick=()=>openActivePreviewFullscreen({focusedOnly:true});
 document.getElementById('mediaFullscreenCloseBtn').onclick=()=>closeMediaFullscreen({forceClose:true});
 window.countPlaying=()=>[...new Set([...audios,...document.querySelectorAll('audio')])].filter(audio=>!audio.paused&&!audio.ended).length;
 window.audioState=()=>({playing:countPlaying(),same:document.querySelector('#mediaFullscreenContent audio')===musicPlayer.tempAudio,time:musicPlayer.tempAudio.currentTime,paused:musicPlayer.tempAudio.paused});
 window.fixtureReady=true;
 </script></body>`)));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port+'/audio-check');await page.waitForFunction(()=>window.fixtureReady&&countPlaying()===1&&musicPlayer.tempAudio.readyState>=2);
  await page.evaluate(()=>{musicPlayer.tempAudio.pause();musicPlayer.tempAudio.currentTime=2;});
  await page.waitForFunction(()=>!musicPlayer.tempAudio.seeking&&musicPlayer.tempAudio.currentTime>=2);
  await page.evaluate(()=>{document.querySelector('.audio-preview-toggle').click();document.getElementById('filePreviewFullscreenBtn').click();});
  await page.waitForFunction(()=>document.querySelector('#mediaFullscreenContent audio')?.readyState>=2);
  const inspector=await page.context().newCDPSession(page);await inspector.send('DOM.enable');
  const timelineGeometry=async()=>{
   const tree=(await inspector.send('DOM.getDocument',{depth:-1,pierce:true})).root;
   const walk=node=>[node,...(node.children||[]).flatMap(walk),...(node.shadowRoots||[]).flatMap(walk)];
   const full=walk(tree).find(node=>node.attributes?.includes('mediaFullscreenContent'));
   const timeline=walk(full).find(node=>node.attributes?.includes('-webkit-media-controls-timeline'));
   const box=timeline&&await inspector.send('DOM.getBoxModel',{nodeId:timeline.nodeId}).catch(()=>null);
   return {width:box?.model.width||0,height:box?.model.height||0,x:box?.model.content[0]||0,y:box?.model.content[1]||0};
  };
  const firstTimeline=await timelineGeometry();assert.ok(firstTimeline.width>50&&firstTimeline.height>0,'audio A must show its native seek bar: '+JSON.stringify(firstTimeline));
  const actual=await page.evaluate(()=>audioState());assert.equal(actual.playing,1,'preview + fullscreen must have one audible owner: '+JSON.stringify(actual));assert.equal(actual.same,true,'fullscreen must reuse the preview audio');assert.ok(actual.time>=2,'fullscreen must retain progress');
  await page.mouse.click(firstTimeline.x+firstTimeline.width*.7,firstTimeline.y+firstTimeline.height/2);
  await page.waitForFunction(()=>musicPlayer.tempAudio.currentTime>8);
  await page.locator('#mediaFullscreenCloseBtn').click();assert.equal(await page.evaluate(()=>countPlaying()),1,'closing fullscreen retains the sole preview owner');
  await page.evaluate(()=>{musicPlayer.tempAudio.pause();document.getElementById('filePreviewFullscreenBtn').click();});
  await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,150)));assert.equal(await page.evaluate(()=>countPlaying()),0,'entering fullscreen preserves a paused preview');await page.locator('#mediaFullscreenCloseBtn').click();
  await page.evaluate(async()=>{await musicPlayer.tempAudio.play();document.getElementById('filePreviewFullscreenBtn').click();mediaFullscreenItems.push({fileInfo:{id:'second',name:'second.wav'},storedFile:{},type:'audio/wav',url:'/tone.wav'});navigateMediaFullscreen(1);});
  await page.waitForFunction(()=>document.querySelector('#mediaFullscreenContent audio')?.readyState>=2&&countPlaying()===1);assert.equal(await page.evaluate(()=>musicPlayer.tempAudio.paused),true,'navigating to another audio pauses the preview owner');
  const secondTimeline=await timelineGeometry();assert.ok(secondTimeline.width>50&&secondTimeline.height>0,'audio B must keep its native seek bar');
  await page.evaluate(()=>navigateMediaFullscreen(-1));
  const restoredTimeline=await timelineGeometry();assert.ok(restoredTimeline.width>50&&restoredTimeline.height>0,'returning to audio A must keep its seek bar');
  assert.equal(await page.evaluate(()=>document.querySelector('#mediaFullscreenContent audio')===musicPlayer.tempAudio),true);
  await page.evaluate(()=>navigateMediaFullscreen(1));await page.waitForFunction(()=>countPlaying()===1);
  await page.locator('#mediaFullscreenCloseBtn').click();assert.equal(await page.evaluate(()=>countPlaying()),0,'closing generated fullscreen audio stops it');
  assert.deepEqual(errors,[]);console.log('PASS: one audio owner; A/B native seek bars visible and seekable; progress, pause and cleanup retained');
 }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
