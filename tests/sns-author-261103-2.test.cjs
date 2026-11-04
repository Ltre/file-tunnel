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
test('a slow conversion publishes one placeholder and updates its real resource count through failure and retry', async () => {
    const source = { id: 'source', sourceUrl: url };
    const original = { snsSources: [source], snsMediaItems: [{ id: 'video', sourceId: 'source', mediaKind: 'video' }] };
    const history = new Map([['post', original]]), updates = [];
    let inspected, releaseVideo, rejectImage = true, publications = 0;
    const publisher = sns.createSnsPostPublisher({
        trackProgress: true, authorize() {}, record: (_sid, key) => history.get(key),
        existing: () => [...history.values()].find(row => row.type === 'markdown'),
        inspect: () => new Promise(resolve => { inspected = () => resolve({ body: 'The post', images: [photo] }); }),
        acquire: () => new Promise(resolve => { releaseVideo = () => resolve({ type: 'file', fileInfo: { id: 'video', type: 'video/mp4', size: 3 } }); }),
        image: async () => { if (rejectImage) throw Error('SNS_POST_IMAGE_INVALID'); return { fileInfo: { id: 'photo', type: 'image/png', size: 3 } }; },
        cleanup() {}, sender: () => ({ sender: 'bot' }),
        publish: (_sid, row) => { publications++; history.set(row.id, row); },
        updatePublished: (_sid, row) => { updates.push(row); history.set(row.id, row); }
    });
    const args = { sessionId: 'target', messageId: 'post', sourceId: 'source', deviceId: 'device' };
    const next = () => new Promise(resolve => setImmediate(resolve));
    const first = publisher.start(args);
    const failed = assert.rejects(first.promise, /SNS_POST_IMAGE_INVALID/);
    await next();
    assert.equal(publications, 1, 'the record is visible before the post metadata arrives');
    assert.equal(history.get(first.id).snsMarkdownProgress.stage, 'inspect');
    assert.equal(publisher.start(args), first);
    inspected(); await next();
    assert.deepEqual(history.get(first.id).snsMarkdownProgress, { stage: 'resources', frameworkReady: true, done: 0, total: 2, resource: 'video' });
    releaseVideo(); await failed;
    const failure = history.get(first.id).snsMarkdownProgress;
    assert.equal(failure.stage, 'failed');
    assert.equal(failure.done, 1); assert.equal(failure.total, 2);
    rejectImage = false;
    const retry = publisher.start(args);
    assert.equal(retry.id, first.id);
    await next(); inspected(); await next(); releaseVideo();
    const post = await retry.promise;
    assert.equal(publications, 1);
    assert.equal(post.snsMarkdownProgress, undefined);
    assert.equal(post.markdownAttachments.length, 2);
    assert.ok(updates.some(row => row.snsMarkdownProgress?.stage === 'publishing' && row.snsMarkdownProgress.done === 2));
    assert.ok(updates.every((row, index) => !index || row.snsMarkdownRevision > updates[index - 1].snsMarkdownRevision));

    history.delete(post.id);
    const cancelled = publisher.start(args);
    const removed = assert.rejects(cancelled.promise, /SNS_POST_PLACEHOLDER_REMOVED/);
    await next(); inspected(); await next();
    history.delete(cancelled.id);
    releaseVideo(); await removed;
    assert.equal(history.has(cancelled.id), false, 'a removed placeholder stays deleted after an upstream response');
});
test('bundled post publication writes one Markdown record and keeps avatar, photos and video under that record', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-bundle-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = { id: 'source', messageId: 'post', sourceUrl: url };
    const original = { snsSources: [source], snsMediaItems: [{ id: 'video-item', sourceId: 'source', mediaKind: 'video' }] };
    const published = [], registered = [], cleaned = [];
    const publish = (_sid, record) => published.push(record);
    const fileInfo = asset => ({ id: asset.id, name: asset.name, type: asset.type, size: asset.size, markdownOwnerId: asset.markdownOwnerId });
    let fail = false;
    const publisher = sns.createSnsPostPublisher({
        authorize() {}, record: (_sid, id) => id === 'post' && original, existing: () => null,
        inspect: async () => ({ ...media.fromPost(modern, id), title: 'Post' }), publish, sender: () => ({ sender: 'bot' }),
        cleanup: (_sid, owner) => cleaned.push(owner),
        acquire: async (_sid, _message, _item, owner) => ({ type: 'file', id: 'legacy-video', fileInfo: {
            id: 'video-file', name: 'video.mp4', type: 'video/mp4', size: 12, markdownOwnerId: owner
        } }),
        image: sns.createSnsPostImagePublisher({
            assetDir: dir, registerAsset: asset => registered.push(asset), fileInfo, publish,
            record: () => null, sender: () => ({ sender: 'bot' }),
            readImage: async value => { if (fail && value === avatar) throw Error('avatar unavailable'); return { data: Buffer.from([1]), type: 'image/png', url: value }; }
        })
    });
    const args = { sessionId: 'target', messageId: 'post', sourceId: 'source', deviceId: 'device' };
    const post = await publisher.start(args).promise;
    assert.deepEqual(published, [post]);
    assert.equal(post.markdownAttachments.length, 3);
    for (const file of post.markdownAttachments) {
        assert.equal(file.markdownOwnerId, post.id);
        assert.ok(post.markdown.includes('tunnel-blob:target/' + post.id + '/' + file.id));
    }
    assert.equal(registered.length, 2);
    fail = true;
    const incomplete = publisher.start(args);
    await assert.rejects(incomplete.promise, /avatar unavailable/);
    assert.deepEqual(published, [post]);
    assert.deepEqual(cleaned, [incomplete.id]);
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
