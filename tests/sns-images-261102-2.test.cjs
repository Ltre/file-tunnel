'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { inspectSnsPost, readWebPost, readSnsPostContent, readPostImage, createTunnelSnsPostPublisher } = require('../server/sns-post-markdown');

const postId = '2117114477615190025';
const postUrl = 'https://x.com/whyyoutouzhele/status/' + postId + '?a=Q6WRYJDzeW-alwfaKNo&s=20';
const images = ['HWFxQjHaAAAdGLe.jpg', 'HWFxSusbQAAzki_.jpg', 'HWFxVSba8AA_3uE.png', 'HWFxX4raoAAdY88.png']
    .map(name => 'https://pbs.twimg.com/media/' + name);

// Reduced from the public HTML fetched on 2026-11-02: X serializes the focal
// TweetResultByRestId JSON inside a router hydration result.value string.
function tweet(overrides = {}) {
    return { __typename: 'Tweet', rest_id: postId, details: { full_text: 'short text' },
        note_tweet: { note_tweet_results: { result: { text: 'Complete post text\nSecond paragraph' } } },
        media_entities2: images.map(media_url_https => ({ type: 'photo', media_url_https })),
        ...overrides };
}
function payload(result = tweet(), id = postId) {
    return { data: { tweet_result_by_rest_id: { rest_id: id, result } } };
}
function page(data = payload(), og = '') {
    return '<meta property="og:description" content="Summary only">' +
        (og ? '<meta property="og:image" content="' + og + '">' : '') +
        '<script>$_TSR.router=($R=>$R[0]={result:$R[1]={kind:"Result.Ok",value:' +
        JSON.stringify(JSON.stringify(data)) + '}})({});</script>';
}
function request(html, embedded) {
    return async (url, options) => {
        if (new URL(url).hostname === 'cdn.syndication.twimg.com') {
            assert.equal(options.cookie, undefined);
            if (embedded) return { type: 'application/json', data: Buffer.from(JSON.stringify(embedded)) };
            throw Error('SNS_POST_TIMEOUT');
        }
        assert.equal(new URL(url).hostname, 'x.com');
        return { type: 'text/html', data: Buffer.from(html) };
    };
}
const noVideo = async () => { throw Error('No video could be found in this tweet'); };

test('X HTML hydration retains all four focal-post photos when the public embed times out, with or without an OG preview', async () => {
    for (const og of ['', 'https://pbs.twimg.com/media/HWFxQjHaAAAdGLe?format=webp&name=large']) {
        const metadata = await inspectSnsPost({ sourceUrl: postUrl }, { runMetadata: async () => ({ description: 'Extractor text' }), request: request(page(payload(), og)) });
        assert.deepEqual(metadata.images, images);
        assert.equal(metadata.body, 'Extractor text');
    }
});

test('X hydration photos are saved as four tunnel files before the Markdown references are published', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-images-261102-2-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = { id: 'source', messageId: 'post', sourceUrl: postUrl };
    const history = [{ message: { id: 'post', snsSources: [source], snsMediaItems: [] } }];
    const record = (_sid, id) => history.find(entry => entry.message.id === id)?.message;
    const reads = [], registrations = [];
    const service = createTunnelSnsPostPublisher({ assetDir: dir, record, session: () => ({ history }), authorize() {},
        metadata: noVideo, request: request(page()), buildItem() { throw Error('unexpected video'); }, update() {},
        acquire() { throw Error('unexpected media acquisition'); }, registerAsset: asset => registrations.push(asset),
        fileInfo: asset => ({ id: asset.id, name: asset.name, size: asset.size, type: asset.type }), sender: () => ({ sender: 'sns-server' }),
        publish: (sid, message) => {
            assert.equal(sid, 'target-tunnel');
            if (message.type === 'markdown') assert.equal(registrations.length, 4);
            history.push({ message });
        },
        readImage: url => readPostImage(url, { request: async () => {
            reads.push(url);
            return { type: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) };
        } }) });
    const args = { sessionId: 'target-tunnel', messageId: 'post', sourceId: 'source', deviceId: 'device' };
    const markdown = await service.start(args).promise;
    assert.deepEqual(reads, images);
    const refs = [...markdown.markdown.matchAll(/!\[[^\]]*\]\(tunnel-blob:([\w-]+)\/([\w.-]+)\/([\w.-]+)\)/g)];
    assert.equal(refs.length, 4);
    for (const [, sid, messageId, fileId] of refs) {
        assert.equal(sid, 'target-tunnel');
        assert.equal(record(sid, messageId).fileInfo.id, fileId);
        assert.ok(fs.existsSync(path.join(dir, fileId)));
    }
    assert.doesNotMatch(markdown.markdown, /pbs\.twimg/);
    await service.start(args).promise;
    assert.equal(reads.length, 4, 'a completed post must retain its acquisition identity');
});

test('partial embed or hydration responses cannot replace a fuller four-photo response', async () => {
    for (const [htmlImages, embedImages] of [[images, images.slice(0, 1)], [images.slice(0, 1), images]]) {
        const html = page(payload(tweet({ media_entities2: htmlImages.map(media_url_https => ({ type: 'photo', media_url_https })) })));
        const embedded = { id_str: postId, text: 'Embedded text', photos: embedImages.map(url => ({ url })) };
        const post = await readSnsPostContent(postUrl, { request: request(html, embedded) });
        assert.deepEqual(post.images, images);
    }
    const html = page(payload(tweet({ media_entities2: [{ type: 'photo', media_url_https: images[0] }] }))) + page();
    assert.deepEqual((await readSnsPostContent(postUrl, { request: request(html) })).images, images);
});

test('hydration only accepts the focal Tweet photo entities, excluding replies, quoted photos, video thumbnails, and unsafe URLs', async () => {
    const result = tweet({ media_entities2: [
        { type: 'video', media_url_https: images[1] },
        { type: 'photo', media_url_https: 'http://127.0.0.1/private.png' },
        { type: 'photo', media_url_https: 'https://pbs.twimg.com.evil.test/media/a.png' },
        { type: 'photo', media_url_https: 'https://pbs.twimg.com/profile_images/avatar.png' },
        { type: 'photo', media_url_https: images[0] }, { type: 'photo', media_url_https: images[0] } ],
        quoted_tweet_results: { rest_id: 'different', result: tweet({ rest_id: 'different' }) } });
    const post = await readSnsPostContent(postUrl, { request: request(page(payload(result))) });
    assert.deepEqual(post.images, [images[0]]);
    for (const data of [payload(tweet(), 'different'), payload(tweet({ rest_id: 'different' })),
        payload(tweet({ media_entities2: [], quoted_tweet_results: { result: tweet({ rest_id: 'quoted' }) } })),
        payload(tweet({ media_entities2: [], retweeted_status_result: { result: tweet({ rest_id: 'retweeted' }) } })),
        { data: { threaded_conversation_with_injections_v2: { entries: [payload()] } } }]) {
        assert.deepEqual((await readSnsPostContent(postUrl, { request: request(page(data)) })).images, []);
    }
    let calls = 0;
    const redirected = await readWebPost(postUrl, { request: async () => ++calls === 1
        ? { redirect: 'https://x.com/other/status/123' }
        : { type: 'text/html', data: Buffer.from(page(payload(tweet({ rest_id: '123' }), '123'))) } });
    assert.deepEqual(redirected.images, [], 'a redirect must not change the requested focal-post identity');
});

test('HTML script content stays inert, malformed hydration preserves the OG fallback, and the image limit still applies', async () => {
    const og = images[0];
    const html = '<script>throw Error("must never run");result={value:"not JSON"}</script>' +
        '<script>result={value:undefined}</script><meta property="og:image" content="' + og + '">';
    assert.deepEqual((await readSnsPostContent(postUrl, { request: request(html) })).images, [og]);
    const many = tweet({ media_entities2: Array.from({ length: 21 }, (_, i) => ({ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/' + i + '.png' })) });
    await assert.rejects(readWebPost(postUrl, { request: request(page(payload(many))) }), /IMAGE_LIMIT/);
    const otherPlatform = await readWebPost('https://www.instagram.com/p/fixture/', {
        request: async () => ({ type: 'text/html', data: Buffer.from(page()) }) });
    assert.deepEqual(otherPlatform.images, [], 'X hydration parsing must not apply to another platform');
});
