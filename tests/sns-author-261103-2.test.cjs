'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const media=require('../server/twitter-post-media'),sns=require('../server/sns-post-markdown');
const id='2117114477615190025',url='https://x.com/fixture/status/'+id,avatar='https://pbs.twimg.com/profile_images/123/avatar_normal.jpg',photo='https://pbs.twimg.com/media/photo.jpg';
const modern={__typename:'Tweet',rest_id:id,details:{full_text:'Focal post'},core:{user_results:{result:{core:{name:'Author < &',screen_name:'original_user'},avatar:{image_url:avatar}}}},media_entities2:[{type:'photo',media_url_https:photo}]};
function page(post=modern){return '<script>result={value:'+JSON.stringify(JSON.stringify({data:{tweet_result_by_rest_id:{rest_id:id,result:post}}}))+'}</script>';}
test('modern hydration, legacy GraphQL and embed authors retain an avatar and traceable handle outside post photos',async()=>{
    const variants=[modern,{rest_id:id,legacy:{full_text:'Post'},core:{user_results:{result:{legacy:{name:'Author < &',screen_name:'original_user',profile_image_url_https:avatar}}}}},
        {id_str:id,text:'Post',user:{name:'Author < &',screen_name:'original_user',profile_image_url_https:avatar},photos:[{url:photo}]}];
    for(const post of variants){const result=media.fromPost(post,id);assert.equal(result.author,'Author < &');assert.equal(result.authorHandle,'original_user');assert.equal(result.authorUrl,'https://x.com/original_user');assert.equal(result.authorAvatar,avatar);assert.ok(!result.images.includes(avatar));}
    const inspected=await sns.inspectSnsPost({sourceUrl:url},{runMetadata:async()=>({description:'Full text'}),request:async target=>new URL(target).hostname==='x.com'?{type:'text/html',data:Buffer.from(page())}:{type:'application/json',data:Buffer.from(JSON.stringify(variants[2]))}});
    assert.equal(inspected.authorHandle,'original_user');assert.equal(inspected.authorAvatar,avatar);assert.deepEqual(inspected.images,[photo]);
});
test('author merging fills partial channels and ignores quoted users, unsafe avatars and malformed handles',()=>{
    const bad={...modern,core:{user_results:{result:{core:{name:'Focal',screen_name:'bad/user'},avatar:{image_url:'http://127.0.0.1/avatar.png'}}}},quoted_tweet_results:{result:modern}};
    const parsed=media.fromPost(bad,id);assert.equal(parsed.author,'Focal');assert.equal(parsed.authorHandle,'');assert.equal(parsed.authorAvatar,'');
    const merged=media.mergeParts([{body:'Full body',structuredBody:true,images:[photo]},media.fromPost(modern,id)]);
    assert.equal(merged.authorHandle,'original_user');assert.equal(merged.authorAvatar,avatar);assert.equal(merged.body,'Full body');
});
test('avatar is copied once into the target tunnel, appears beside a safely escaped author link, and upgrades existing Markdown in place',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sns-author-261103-2-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const source={id:'source',messageId:'post',sourceUrl:url},records=new Map([['post',{id:'post',snsSources:[source],snsMediaItems:[]}]]),assets=[],reads=[];
    let existing={id:'old-md',type:'markdown',markdown:'Old post',timestamp:12345,snsAcquisition:{source:'sns-post-markdown',mediaComplete:true}},updates=0;
    const publisher=sns.createSnsPostPublisher({authorize(){},record:(_sid,key)=>records.get(key),inspect:async()=>({...media.fromPost(modern,id),title:'Post'}),prepare(){},acquire(){throw Error('no video');},
        image:sns.createSnsPostImagePublisher({assetDir:dir,record:(_sid,key)=>records.get(key),registerAsset:value=>assets.push(value),fileInfo:value=>({id:value.id,name:value.name,type:value.type,size:value.size}),sender:()=>({sender:'fixture'}),publish:(_sid,message)=>records.set(message.id,message),readImage:async value=>{reads.push(value);return {data:Buffer.from([137,80,78,71,13,10,26,10]),type:'image/png',url:value};}}),
        existing:()=>existing,sender:()=>({sender:'fixture'}),publish(){throw Error('must update existing Markdown');},updatePublished:async(_sid,value)=>{updates++;existing=value;}});
    const args={sessionId:'target',messageId:'post',sourceId:'source',deviceId:'device'};
    const message=await publisher.start(args).promise;
    assert.equal(message.id,'old-md');assert.equal(message.timestamp,12345);assert.equal(updates,1);assert.equal(assets.length,2);assert.deepEqual(new Set(reads),new Set([avatar,photo]));
    assert.match(message.markdown,/<img[^>]+class="sns-post-avatar"[^>]+src="tunnel-blob:target\//);assert.match(message.markdown,/width="28" height="28"/);
    assert.match(message.markdown,/Author &lt; &amp;/);assert.match(message.markdown,/@original_user/);assert.match(message.markdown,/href="https:\/\/x.com\/original_user"/);
    assert.doesNotMatch(message.markdown,/https:\/\/pbs.twimg/);assert.equal((message.markdown.match(/!\[/g)||[]).length,1,'avatar is not duplicated as a full post photo');
    assert.equal(message.snsAcquisition.authorVersion,1);await publisher.start(args).promise;assert.equal(updates,1);assert.equal(reads.length,2);
});
