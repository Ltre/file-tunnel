'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {inspectSnsPost,readSnsPostContent}=require('../server/sns-post-markdown');
const id='2116545205373673955',url='https://x.com/fixture/status/'+id;
const photo='https://pbs.twimg.com/media/actual-photo.jpg',video='https://video.twimg.com/amplify_video/2116545164806438912/vid/avc1/720x1280/fixture.mp4';
const playable={id:'2116545164806438912',webpage_url:url,ext:'mp4',formats:[{url:video,ext:'mp4',vcodec:'avc1',acodec:'mp4a'}]};
function cookie(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sns-mixed-261103-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'cookies.txt');fs.writeFileSync(file,'.x.com\tTRUE\t/\tTRUE\t0\tauth_token\tfixture');return file;}
function page(media,restricted=false){const post=restricted?{__typename:'TweetTombstone',tombstone:{__typename:'BlurredMediaTombstone',text:{text:'To view this media, you need to log in to X.'}}}:{__typename:'Tweet',rest_id:id,details:{full_text:'Mixed post'},media_entities2:media};return '<meta property="og:description" content="Mixed post"><meta property="og:image" content="https://pbs.twimg.com/media/blurred-preview.jpg"><script>result={value:'+JSON.stringify(JSON.stringify({data:{tweet_result_by_rest_id:{rest_id:id,result:post}}}))+'}</script>';}
const mixed=[{type:'photo',media_url_https:photo},{type:'video',id_str:playable.id,media_key:'7_'+playable.id,video_info:{variants:[{content_type:'video/mp4',bitrate:512000,url:video}]}}];
function responses(publicHtml,privateHtml){return async(target,options)=>{if(new URL(target).hostname==='cdn.syndication.twimg.com')throw Error('SNS_POST_CONTENT_UNAVAILABLE');return{type:'text/html',data:Buffer.from(options.cookie?privateHtml:publicHtml)};};}

test('a successful zero-format anonymous result and a preview image do not stop authenticated video recovery',async t=>{
    const file=cookie(t),calls=[];
    const result=await inspectSnsPost({sourceUrl:url},{cookieFileForUrl:()=>file,request:responses(page([],true),page(mixed)),runMetadata:async(_url,options)=>{
        calls.push(options.noCookie);return options.noCookie?{id,_type:'video',description:'Mixed post',formats:[]}:playable;
    }});
    assert.deepEqual(result.images,[photo]);assert.equal(result.mediaMetas.filter(meta=>meta.formats?.length).length,1);
    assert.ok(result.mediaMetas.some(meta=>meta.id===playable.id));
    assert.doesNotMatch(result.images.join(' '),/blurred-preview/);
});

test('when public inventory identifies an unavailable video, Cookie extraction is attempted even though the photos already succeeded',async t=>{
    const file=cookie(t),calls=[],withoutVariant=mixed.map(item=>item.type==='video'?{...item,video_info:{variants:[]}}:item);
    const result=await inspectSnsPost({sourceUrl:url},{cookieFileForUrl:()=>file,request:responses(page(withoutVariant),page(withoutVariant)),runMetadata:async(_url,options)=>{
        calls.push(options.noCookie);return options.noCookie?{id,formats:[]}:playable;
    }});
    assert.deepEqual(calls,[true,false]);assert.deepEqual(result.images,[photo]);assert.equal(result.mediaMetas.length,1);
});

test('only the still-missing part reaches the headless fallback and complete public media spends no Cookie or browser launch',async t=>{
    const file=cookie(t),calls=[];
    const result=await inspectSnsPost({sourceUrl:url},{cookieFileForUrl:()=>file,request:responses(page(mixed.map(item=>item.type==='video'?{...item,video_info:{variants:[]}}:item)),page([],true)),runMetadata:async(_url,options)=>{calls.push(options.noCookie?'anonymous':'cookie');return {id,formats:[]};},readBrowserPost:async()=>{calls.push('browser');return{images:[photo],videoMetas:[playable],videoIds:[playable.id],inventoryKnown:true,body:'Mixed post',structuredBody:true};}});
    assert.deepEqual(calls,['anonymous','cookie','browser']);assert.deepEqual(result.images,[photo]);assert.equal(result.mediaMetas.length,1);
    const publicCalls=[];await inspectSnsPost({sourceUrl:url},{cookieFileForUrl:()=>file,request:responses(page(mixed),page(mixed)),runMetadata:async()=>playable,readBrowserPost:async()=>{publicCalls.push('browser');throw Error('must not launch');}});
    assert.deepEqual(publicCalls,[]);
});
test('a still-missing known video fails clearly instead of publishing pictures as a complete post',async t=>{
    const file=cookie(t),withoutVariants=mixed.map(item=>item.type==='video'?{...item,video_info:{variants:[]}}:item);
    await assert.rejects(inspectSnsPost({sourceUrl:url},{cookieFileForUrl:()=>file,request:responses(page(withoutVariants),page(withoutVariants)),runMetadata:async()=>({id,formats:[]}),readBrowserPost:async()=>{throw Error('SNS_X_BROWSER_UNAVAILABLE');}}),/SNS_POST_MEDIA_INCOMPLETE/);
});
test('two partial extraction channels combine their distinct videos without duplicates or a browser launch',async t=>{
    const file=cookie(t),second={...playable,id:'2116545164806438999',formats:[{url:'https://video.twimg.com/amplify_video/2116545164806438999/vid/second.mp4',vcodec:'h264'}]};
    const inventory=[{type:'photo',media_url_https:photo},...[playable,second].map(meta=>({type:'video',id_str:meta.id,video_info:{variants:[]}}))];
    const result=await inspectSnsPost({sourceUrl:url},{cookieFileForUrl:()=>file,request:responses(page(inventory),page(inventory)),runMetadata:async(_url,options)=>options.noCookie?playable:second,readBrowserPost:async()=>{throw Error('not needed');}});
    assert.deepEqual(result.mediaMetas.map(meta=>meta.id),[playable.id,second.id]);assert.deepEqual(result.images,[photo]);
});
test('refreshing a legacy partial X Markdown updates its original record and reuses previously acquired media',async t=>{
    const {createSnsPostPublisher}=require('../server/sns-post-markdown'),source={id:'source',sourceUrl:url};let inspected=0,updated=0,published=0;
    let existing={id:'old-markdown',type:'markdown',markdown:'old partial',snsAcquisition:{source:'sns-post-markdown',sourceMessageId:'post',sourceId:'source'}};
    const publisher=createSnsPostPublisher({authorize(){},record:()=>({snsSources:[source],snsMediaItems:[]}),inspect:async()=>{inspected++;return{title:'Recovered',body:'Post',images:[],mediaComplete:true};},acquire(){throw Error('unexpected');},image(){throw Error('unexpected');},publish(){published++;},updatePublished:async(_sid,message)=>{updated++;existing=message;},existing:()=>existing,sender:()=>({sender:'fixture'})});
    const args={sessionId:'tunnel',messageId:'post',sourceId:'source',deviceId:'device'};
    const result=await publisher.start(args).promise;assert.equal(result.id,'old-markdown');assert.equal(updated,1);assert.equal(published,0);assert.equal(inspected,1);
    assert.equal(result.snsAcquisition.mediaComplete,true);await publisher.start(args).promise;assert.equal(inspected,1);
});
test('headless request policy blocks local URLs, arbitrary hosts and heavy media without weakening browser sandboxing',()=>{
    const {allowedRequest}=require('../server/twitter-post-browser');
    assert.equal(allowedRequest('https://x.com/i/api/graphql/test/TweetDetail','XHR'),true);
    for(const value of ['http://127.0.0.1/','http://10.0.0.9/','file:///tmp/secret','https://x.com.evil.test/','https://user:secret@x.com/','https://x.com:8443/'])assert.equal(allowedRequest(value,'XHR'),false,value);
    assert.equal(allowedRequest('https://video.twimg.com/video.mp4','Media'),false);
    const {directVideoUrl}=require('../server/twitter-post-media');assert.equal(directVideoUrl(playable),video);assert.equal(directVideoUrl({url:'https://10.0.0.9/video.mp4'}),'');
});
test('an expired direct video link retains the original extractor and playlist fallback, while cancellation never restarts',async()=>{
    const {downloadWithFallback}=require('../server/twitter-post-media'),calls=[];
    const file=await downloadWithFallback(video,url,2,async(target,index)=>{calls.push([target,index]);if(target===video)throw Error('HTTP Error 403');return 'fixture.mp4';});
    assert.equal(file,'fixture.mp4');assert.deepEqual(calls,[[video,0],[url,2]]);
    let attempts=0;await assert.rejects(downloadWithFallback(video,url,2,async()=>{attempts++;throw Error('download-cancelled');}),/cancelled/);assert.equal(attempts,1);
});
test('the tunnel publisher persists a photo and a video, upgrades legacy Markdown in place and avoids a second photo download',async t=>{
    const {createTunnelSnsPostPublisher}=require('../server/sns-post-markdown'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'sns-mixed-publish-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const source={id:'source',messageId:'post',sourceUrl:url},original={id:'post',snsSources:[source],snsMediaItems:[]},history=[{message:original}];let phase=0,imageReads=0,videoReads=0;
    const record=(_sid,id)=>history.find(entry=>entry.message.id===id)?.message;
    const service=createTunnelSnsPostPublisher({assetDir:dir,record,session:()=>({history}),authorize(){},sender:()=>({sender:'fixture'}),
        metadata:async()=>phase?playable:{id,description:'Photo initially returned',formats:[]},request:async()=>({type:'text/html',data:Buffer.from(page(phase?mixed:[mixed[0]]))}),
        buildItem:(_id,from,meta)=>({id:'video-item',sourceId:from.id,mediaKind:'video',youtubeVideoId:meta.id}),
        update:(_sid,message)=>{const found=history.find(entry=>entry.message.id===message.id);if(!found)return false;found.message=message;return true;},
        acquire:async()=>{videoReads++;assert.equal(record('tunnel','post').snsMediaItems[0].directMediaUrl,video);const generated={id:'video-record',type:'file',fileInfo:{id:'video-file',name:'fixture.mp4',type:'video/mp4'}};history.push({message:generated});return{generatedMessageId:generated.id};},
        registerAsset(){},fileInfo:asset=>({id:asset.id,name:asset.name,type:asset.type,size:asset.size}),publish:(_sid,message)=>history.push({message}),
        readImage:async()=>{imageReads++;return{data:Buffer.from([137,80,78,71,13,10,26,10]),type:'image/png'};}});
    const args={sessionId:'tunnel',messageId:'post',sourceId:'source',deviceId:'device'},first=await service.start(args).promise;
    delete first.snsAcquisition.mediaComplete;phase=1;
    const completed=await service.start(args).promise;
    assert.equal(completed.id,first.id);assert.equal(imageReads,1);assert.equal(videoReads,1);assert.match(completed.markdown,/<video controls/);assert.match(completed.markdown,/!\[/);
    assert.equal(history.filter(entry=>entry.message.type==='markdown').length,1);assert.equal(completed.snsAcquisition.mediaComplete,true);
});
