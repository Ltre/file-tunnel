'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {inspectSnsPost,readWebPost}=require('../server/sns-post-markdown');
const url='https://x.com/whyyoutouzhele/status/2117114477615190025?a=Q6WRYJDzeW-alwfaKNo&s=20';
const images=[1,2,3,4].map(i=>'https://pbs.twimg.com/media/fixture-'+i+'.jpg');
function publicPage(){return '<meta property="og:description" content="Public post text"><script>result={value:'+JSON.stringify(JSON.stringify({data:{tweet_result_by_rest_id:{rest_id:'2117114477615190025',result:{__typename:'Tweet',rest_id:'2117114477615190025',media_entities2:images.map(media_url_https=>({type:'photo',media_url_https}))}}}}))+'}</script>';}
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sns-env-261103-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'cookies.txt');fs.writeFileSync(file,'.x.com\tTRUE\t/\tTRUE\t0\tauth_token\tfixture');return file;}
test('a public page with four photos succeeds without spending the configured Cookie even if the embed times out',async t=>{
    const cookie=fixture(t),calls=[];
    const result=await inspectSnsPost({sourceUrl:url},{cookieFileForUrl:()=>cookie,runMetadata:async(_url,options)=>{assert.equal(options.noCookie,true);return {description:'Post text from extractor'};},request:async(target,options)=>{
        calls.push({host:new URL(target).hostname,cookie:options.cookie||''});
        if(new URL(target).hostname==='cdn.syndication.twimg.com')throw Error('SNS_POST_TIMEOUT');
        return {type:'text/html',data:Buffer.from(options.cookie?'<title>X</title><div id="react-root">Authenticated app shell</div>':publicPage())};
    }});
    assert.deepEqual(result.images,images);assert.equal(result.body,'Post text from extractor');
    assert.equal(calls.filter(x=>x.host==='x.com'&&x.cookie).length,0);
    assert.equal(calls.filter(x=>x.host==='x.com'&&!x.cookie).length,1,'retry the public page once, without propagating the account cookie');
});
test('the same authenticated shell already works when the embed supplies the four photos',async t=>{
    const cookie=fixture(t);
    const result=await inspectSnsPost({sourceUrl:url},{cookieFileForUrl:()=>cookie,runMetadata:async()=>({description:'Post text'}),request:async target=>new URL(target).hostname==='x.com'
        ?{type:'text/html',data:Buffer.from('<title>X</title>')}
        :{type:'application/json',data:Buffer.from(JSON.stringify({id_str:'2117114477615190025',text:'Post text',photos:images.map(url=>({url}))}))}});
    assert.deepEqual(result.images,images);
});
test('public fallback must not mask HTTP permission/rate errors or retry forever',async t=>{
    const cookie=fixture(t);let calls=0;
    await assert.rejects(readWebPost(url,{cookieFileForUrl:()=>cookie,request:async()=>{calls++;throw Error('SNS_POST_HTTP_403');}}),/HTTP_403/);
    assert.equal(calls,1);
    calls=0;const result=await readWebPost(url,{cookieFileForUrl:()=>cookie,request:async()=>{calls++;return{type:'text/html',data:Buffer.from('<title>X</title>')};}});
    assert.equal(calls,1);assert.deepEqual(result.images,[]);
});
test('only after public page and embed fail does X try the Cookie once',async t=>{
    const cookie=fixture(t),calls=[];
    const result=await inspectSnsPost({sourceUrl:url},{cookieFileForUrl:()=>cookie,runMetadata:async()=>({description:'Post text'}),request:async(target,options)=>{
        calls.push({host:new URL(target).hostname,cookie:Boolean(options.cookie)});
        if(!options.cookie)throw Error('SNS_POST_TIMEOUT');
        return {type:'text/html',data:Buffer.from(publicPage())};
    }});
    assert.deepEqual(result.images,images);
    assert.equal(calls.filter(x=>x.cookie).length,1);
    assert.ok(calls.slice(0,2).every(x=>!x.cookie));
});
test('another SNS keeps its existing Cookie-first request without X fallback',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sns-other-261103-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const file=path.join(dir,'cookies.txt');fs.writeFileSync(file,'.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tfixture');
    const calls=[];
    await inspectSnsPost({sourceUrl:'https://www.instagram.com/p/example/'},{cookieFileForUrl:()=>file,runMetadata:async(_url,options)=>{assert.equal(options.noCookie,undefined);return {description:'Existing post'};},request:async(target,options)=>{
        calls.push({target,cookie:options.cookie,twitterNetwork:options.twitterNetwork});return{type:'text/html',data:Buffer.from('<title>Example</title>')};
    }});
    assert.equal(calls.length,1);assert.equal(calls[0].cookie,'sessionid=fixture');assert.equal(calls[0].twitterNetwork,false);
});

test('proxied X DNS answers remain pinned, public, scoped, cached and free of account cookies',async()=>{
    const {twitterAddresses}=require('../server/sns-post-markdown');let calls=0;
    const request=async(target,options)=>{
        calls++;assert.equal(new URL(target).hostname,'cloudflare-dns.com');assert.equal(new URL(target).searchParams.get('name'),'pbs.twimg.com');
        assert.equal(options.dnsBootstrap,true);assert.equal(options.cookie,undefined);assert.equal(options.accept,'application/dns-json');
        return{type:'application/dns-json',data:Buffer.from(JSON.stringify({Status:0,Question:[{name:'pbs.twimg.com',type:1}],Answer:[{type:1,TTL:60,data:'140.248.128.159'}]}))};
    };
    assert.deepEqual(await twitterAddresses('pbs.twimg.com','http://fixture:9001',5000,request),[{address:'140.248.128.159',family:4}]);
    await twitterAddresses('pbs.twimg.com','http://fixture:9001',5000,request);assert.equal(calls,1);
    await assert.rejects(twitterAddresses('instagram.com','http://fixture:9001',5000,request),/ADDRESS_DENIED/);
    await assert.rejects(twitterAddresses('pbs.twimg.com','http://fixture:9002',5000,async()=>({type:'application/json',data:Buffer.from(JSON.stringify({Status:0,Question:[{name:'pbs.twimg.com',type:1}],Answer:[{type:1,data:'127.0.0.1'}]}))})),/ADDRESS_DENIED/);
});
test('a suspended author notice is never published as post text or a platform-logo image and spends no Cookie',async t=>{
    const cookie=fixture(t),calls=[];
    const unavailable={data:{tweet_result_by_rest_id:{rest_id:'2117114477615190025',result:{__typename:'TweetUnavailable',unavailable_reason:'Suspended'}}}};
    const html='<meta property="og:description" content="This post is from a suspended account."><meta property="og:image" content="https://abs.twimg.com/default.png"><script>result={value:'+JSON.stringify(JSON.stringify(unavailable))+'}</script>';
    await assert.rejects(inspectSnsPost({sourceUrl:url},{cookieFileForUrl:()=>cookie,runMetadata:async()=>({description:'This post is from a suspended account.'}),request:async(target,options)=>{
        calls.push(Boolean(options.cookie));return new URL(target).hostname==='x.com'?{type:'text/html',data:Buffer.from(html)}:{type:'application/json',data:Buffer.from(JSON.stringify({__typename:'TweetTombstone',tombstone:{text:{text:'This Post is from a suspended account. Learn more'}}}))};
    }}),/SNS_X_AUTHOR_SUSPENDED/);
    assert.ok(calls.every(value=>!value));
});
