'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm'), crypto = require('node:crypto');
const { inspectSnsPost, readTwitterPost, readSnsPostContent, readPostImage, createTunnelSnsPostPublisher } = require('../server/sns-post-markdown');

const postId = '2115396282202407121';
const postUrl = 'https://x.com/nene_koo/status/' + postId + '?s=20';
const images = ['https://pbs.twimg.com/media/fixture-one.jpg', 'https://pbs.twimg.com/media/fixture-two.png'];
const response = () => ({ id_str: postId, text: '只有图片的帖子', user: { name: '作者', screen_name: 'nene_koo' },
    created_at: '2026-10-28T03:04:05.000Z', mediaDetails: images.map(media_url_https => ({ type: 'photo', media_url_https })) });
const noVideo = async () => { throw Error('[twitter] ' + postId + ': No video could be found in this tweet'); };
const request = async (value, options) => {
    const url = new URL(value);
    if (url.hostname === 'cdn.syndication.twimg.com') {
        assert.equal(url.pathname, '/tweet-result'); assert.equal(url.searchParams.get('id'), postId);
        assert.equal(options.cookie, undefined, '账号Cookie不得发送到公开嵌入服务');
        return { type: 'application/json', data: Buffer.from(JSON.stringify(response())) };
    }
    throw Error('SNS_POST_HTTP_404');
};

test('真实帖子检查在视频提取器无视频、帖子HTML不可用时仍读取结构化图片，不把图片当成视频', async () => {
    const metadata = await inspectSnsPost({ sourceUrl: postUrl }, { runMetadata: noVideo, request });
    assert.deepEqual(metadata.images, images);
    assert.equal(metadata.body, '只有图片的帖子'); assert.equal(metadata.author, '作者');
    assert.equal(metadata.mediaParsed, false);
});

test('真实帖子发布流程获取纯图片为目标隧道资源，Markdown不留下外站图片热链，失败来源状态恢复', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-images-261029-3-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = { id: 'source', messageId: 'post', sourceUrl: postUrl, parseStatus: 'failed', parseError: 'No video could be found in this tweet' };
    const original = { id: 'post', snsSources: [source], snsMediaItems: [] }, history = [{ message: original }];
    const record = (_sid, id) => history.find(entry => entry.message.id === id)?.message;
    let acquisitions = 0, registrations = 0;
    const service = createTunnelSnsPostPublisher({ assetDir: dir, record, session: () => ({ history }), authorize() {},
        metadata: async () => {
            original.snsSources = [{ ...source }]; // History updates can replace source objects while inspection waits.
            return noVideo();
        }, request, buildItem() { throw Error('图片不应生成视频下载项'); }, update() {},
        acquire() { acquisitions++; throw Error('不应调用视频下载'); },
        registerAsset(asset) { registrations++; assert.equal(asset.sessionId, 'target-tunnel'); assert.equal(asset.source, 'sns-post-image'); },
        fileInfo: asset => ({ id: asset.id, name: asset.name, size: asset.size, type: asset.type }),
        publish: (_sid, message) => history.push({ message }), sender: () => ({ sender: 'sns-server' }),
        readImage: url => readPostImage(url, { request: async (_url, options) => {
            assert.equal(options.cookie, undefined);
            return { type: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) };
        } }) });
    const job = service.start({ sessionId: 'target-tunnel', messageId: 'post', sourceId: 'source', deviceId: 'device' });
    const markdown = await job.promise;
    assert.equal(acquisitions, 0); assert.equal(registrations, 2);
    assert.equal((markdown.markdown.match(/!\[/g) || []).length, 2);
    assert.match(markdown.markdown, /tunnel-blob:target-tunnel\//); assert.doesNotMatch(markdown.markdown, /pbs\.twimg/);
    assert.equal(original.snsSources[0].parseStatus, 'ready'); assert.equal(original.snsSources[0].parseError, '');
    await service.start({ sessionId: 'target-tunnel', messageId: 'post', sourceId: 'source', deviceId: 'device' }).promise;
    assert.equal(registrations, 2, '已完成帖子重试不能重复下载图片');
});

function scanner(error, upstream = request) {
    const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    let fallbackCalls = 0;
    const context = vm.createContext({ Date, Math, Set, Map, console,
        require(module) {
            assert.equal(module, './server/sns-post-markdown');
            return { readSnsPostContent: (url, options) => { fallbackCalls++; return readSnsPostContent(url, { ...options, request: upstream }); } };
        },
        getSnsCookieFileForUrl: () => '',
        extractSupportedSocialUrls: text => [text],
        createStableSnsId: (...parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32),
        sanitizeString: value => String(value || ''), isYouTubePlaylistOnly: () => false, isYouTubeUrl: () => false,
        runYtDlpJson: async () => { throw Error(error); }, buildSnsMediaItemFromMeta() { throw Error('unexpected video'); } });
    vm.runInContext(source.slice(source.indexOf('function canResumeSnsSource('), source.indexOf('\nfunction createSnsPlaceholderMetadata(')), context);
    return { context, fallbacks: () => fallbackCalls };
}

test('真实历史元数据扫描恢复无视频错误为图片来源，不伪造视频下载项；不重复解析已就绪来源', async () => {
    const f = scanner('No video could be found in this tweet');
    const first = await f.context.buildSnsMetadata(postUrl, 'post');
    assert.equal(first.sources[0].parseStatus, 'ready'); assert.equal(first.sources[0].parseError, '');
    assert.deepEqual(Array.from(first.sources[0].imageUrls), images); assert.equal(first.items.length, 0);
    await f.context.buildSnsMetadata(postUrl, 'post', first); assert.equal(f.fallbacks(), 1);
    const failed = { ...first.sources[0], parseStatus: 'failed', parseError: 'No video could be found in this tweet' };
    assert.equal(f.context.canResumeSnsSource(failed), true);
    const recovered = await f.context.buildSnsMetadata(postUrl, 'post', { sources: [failed], items: [] });
    assert.equal(recovered.sources[0].parseStatus, 'ready'); assert.equal(f.fallbacks(), 2);
});

test('登录、限流及普通网络错误不能被图片后备伪装为就绪；无图片时仍保持失败和有限退避', async () => {
    for (const error of ['Login required', 'HTTP Error 429', 'ETIMEDOUT']) {
        const f = scanner(error), result = await f.context.buildSnsMetadata(postUrl, 'post');
        assert.equal(f.fallbacks(), 0, error); assert.equal(result.sources[0].parseStatus, 'failed', error);
    }
    const empty = scanner('No video could be found in this tweet', async () => { throw Error('SNS_POST_HTTP_404'); });
    const result = await empty.context.buildSnsMetadata(postUrl, 'post');
    assert.equal(result.sources[0].parseStatus, 'failed'); assert.equal(result.sources[0].parseRetryCount, 1);
});

test('公开嵌入响应必须对应同一帖子，只接受photo，不接受错ID、video缩略图、用户头像或私网图片地址', async () => {
    for (const payload of [{}, { id_str: 'different', text: '不属于当前帖子', photos: [{ url: images[0] }] }]) {
        await assert.rejects(readTwitterPost(postUrl, { request: async () => ({ type: 'application/json', data: Buffer.from(JSON.stringify(payload)) }) }), /CONTENT_UNAVAILABLE/);
    }
    const payload = { ...response(), mediaDetails: [
        { type: 'video', media_url_https: images[0] }, { type: 'photo', media_url_https: 'http://127.0.0.1/image.jpg' },
        { type: 'photo', media_url_https: 'https://pbs.twimg.com.evil.test/media/fake.jpg' },
        { type: 'photo', media_url_https: 'https://pbs.twimg.com/profile_images/avatar.jpg' },
        { type: 'photo', media_url_https: images[1] }, { type: 'photo', media_url_https: images[1] } ] };
    const post = await readTwitterPost(postUrl, { request: async () => ({ type: 'application/json', data: Buffer.from(JSON.stringify(payload)) }) });
    assert.deepEqual(post.images, [images[1]]);
    await assert.rejects(readTwitterPost(postUrl, { request: async () => ({ redirect: 'http://127.0.0.1/secret' }) }), /PAGE_INVALID/);
});

test('嵌入接口不扩散到其它SNS；原HTML图片后备保留；正文、视频预览不冒充实际图片', async () => {
    let calls = 0;
    const webpage = await readSnsPostContent('https://www.instagram.com/p/fixture/', { request: async url => {
        calls++; assert.match(url, /^https:\/\/www\.instagram\.com\//);
        return { type: 'text/html', data: Buffer.from('<meta property="og:description" content="图文正文"><meta property="og:image" content="https://cdn.example/a.jpg">') };
    } });
    assert.equal(calls, 1); assert.deepEqual(webpage.images, ['https://cdn.example/a.jpg']);
    const post = await readTwitterPost(postUrl, { request: async () => ({ type: 'application/json',
        data: Buffer.from(JSON.stringify({ id_str: postId, text: '只有正文', mediaDetails: [{ type: 'video', media_url_https: images[0] }] })) }) });
    assert.equal(post.images.length, 0);
});

test('图片数量超限或平台返回登录页、空JSON时不发布伪造图片元数据', async () => {
    await assert.rejects(readTwitterPost(postUrl, { request: async () => ({ type: 'text/html', data: Buffer.from('<title>Log in</title>') }) }), /PAGE_INVALID/);
    const many = { ...response(), mediaDetails: Array.from({ length: 21 }, (_, index) => ({ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/' + index + '.jpg' })) };
    await assert.rejects(readTwitterPost(postUrl, { request: async () => ({ type: 'application/json', data: Buffer.from(JSON.stringify(many)) }) }), /IMAGE_LIMIT/);
});
