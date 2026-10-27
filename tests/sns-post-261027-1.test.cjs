'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { normalizeSnsDownloadUrl } = require('../server/sns-downloader');
const { sourceUrl, publicAddress, cookieHeader, configuredProxy, readPublicUrl, extractPostMetadata, readWebPost, readPostImage,
    buildPostMarkdown, createSnsPostPublisher, createSnsPostImagePublisher, createTunnelSnsPostPublisher } = require('../server/sns-post-markdown');

test('网易云音乐保留hash路由的歌曲ID并支持移动链接，整表不静默下载首项', () => {
    assert.deepEqual(normalizeSnsDownloadUrl('https://music.163.com/#/song?id=550136151&userid=123'), { platform: 'netease', url: 'https://music.163.com/song?id=550136151' });
    assert.equal(normalizeSnsDownloadUrl('https://y.music.163.com/m/song?id=123&app_version=1').url, 'https://music.163.com/song?id=123');
    for (const kind of ['mv', 'program', 'dj']) assert.equal(normalizeSnsDownloadUrl('http://music.163.com/#/' + kind + '?id=7').platform, 'netease');
    assert.equal(normalizeSnsDownloadUrl('https://163cn.tv/abc').platform, 'netease');
    assert.throws(() => normalizeSnsDownloadUrl('https://music.163.com/#/playlist?id=123'), /single-media-required/);
    assert.throws(() => normalizeSnsDownloadUrl('https://music.163.com.evil.test/song?id=1'), /url-required/);
});

test('来源域名及重定向校验拒绝私网、伪装域名与带凭据URL', async () => {
    for (const value of ['http://localhost/post', 'http://127.0.0.1/post', 'https://x.com.evil.test/a', 'https://user:secret@x.com/a']) assert.throws(() => sourceUrl(value));
    for (const ip of ['127.0.0.1', '10.0.0.9', '172.16.1.1', '192.168.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(publicAddress(ip), false, ip);
    assert.equal(publicAddress('8.8.8.8'), true);
    assert.equal(publicAddress('2606:4700:4700::1111'), true);
    await assert.rejects(readPublicUrl('http://127.0.0.1/secret'), /ADDRESS_DENIED/);
    let requests = 0;
    await assert.rejects(readWebPost('https://x.com/user/status/1', { request: async () => { requests++; return { redirect: 'http://127.0.0.1/secret' }; } }), /URL_UNSUPPORTED/);
    assert.equal(requests, 1);
});

test('DNS解析结果包含私网地址时，连接前拒绝，不因域名白名单而放行', async t => {
    const dns = require('node:dns');
    t.mock.method(dns, 'lookup', (_host, _options, callback) => callback(null, [
        { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }
    ]));
    await assert.rejects(readPublicUrl('https://x.com/no-network'), /SNS_POST_ADDRESS_DENIED/);
});

test('HTTP代理通过CONNECT传递已校验的公有IP，代理认证与目的站Cookie不串用', async t => {
    const http = require('node:http'), dns = require('node:dns');
    const server = http.createServer(), sockets = new Set();
    let tunnels = 0, destination = '', proxyAuth = '', requestText = '';
    server.on('connect', (request, socket) => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket));
        tunnels++; destination = request.url; proxyAuth = request.headers['proxy-authorization'];
        assert.equal(request.headers.cookie, undefined);
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.once('data', chunk => {
            requestText = chunk.toString();
            socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
    t.mock.method(dns, 'lookup', (_host, _options, callback) => callback(null, [{ address: '8.8.8.8', family: 4 }]));
    const proxy = 'http://fixture:password@127.0.0.1:' + server.address().port;
    const response = await readPublicUrl('http://x.com/post', { proxy, cookie: 'auth_token=fixture', timeoutMs: 2000 });
    assert.equal(response.data.toString(), 'OK');
    assert.equal(destination, '8.8.8.8:80');
    assert.equal(proxyAuth, 'Basic ' + Buffer.from('fixture:password').toString('base64'));
    assert.match(requestText, /Cookie: auth_token=fixture/i);
    assert.doesNotMatch(requestText, /Proxy-Authorization/i);
    await assert.rejects(readPublicUrl('http://127.0.0.1/secret', { proxy }), /ADDRESS_DENIED/);
    assert.equal(tunnels, 1);
});

test('SOCKS5H代理仍发送已校验IP而非让代理重新解析目标域名', async t => {
    const net = require('node:net'), dns = require('node:dns');
    let requestedAddress = '', requestText = '';
    const sockets = new Set();
    const server = net.createServer(socket => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket));
        let stage = 0, buffered = Buffer.alloc(0);
        socket.on('data', chunk => {
            buffered = Buffer.concat([buffered, chunk]);
            if (stage === 0 && buffered.length >= 3) {
                assert.deepEqual([...buffered], [5, 1, 0]);
                buffered = Buffer.alloc(0); stage = 1; socket.write(Buffer.from([5, 0]));
            } else if (stage === 1 && buffered.length >= 10) {
                assert.equal(buffered[3], 1);
                requestedAddress = [...buffered.subarray(4, 8)].join('.');
                assert.equal(buffered.readUInt16BE(8), 80);
                buffered = Buffer.alloc(0); stage = 2; socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            } else if (stage === 2 && buffered.includes(Buffer.from('\r\n\r\n'))) {
                requestText = buffered.toString(); stage = 3;
                socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
    t.mock.method(dns, 'lookup', (_host, _options, callback) => callback(null, [{ address: '8.8.8.8', family: 4 }]));
    const response = await readPublicUrl('http://x.com/post', { proxy: 'socks5h://127.0.0.1:' + server.address().port, timeoutMs: 2000 });
    assert.equal(response.data.toString(), 'OK');
    assert.equal(requestedAddress, '8.8.8.8');
    assert.match(requestText, /Host: x.com/i);
    assert.equal(configuredProxy(new URL('https://x.com'), { DR2T_ALL_PROXY: 'socks5://fixture', DR2T_PROXY: 'http://fixture' }), 'http://fixture');
    assert.equal(configuredProxy(new URL('https://x.com'), { DR2T_ALL_PROXY: 'socks5://fixture' }), 'socks5://fixture');
    assert.equal(configuredProxy(new URL('https://x.com'), { HTTPS_PROXY: 'http://fixture', NO_PROXY: 'localhost,.x.com' }), '');
});

test('平台Cookie只发送到匹配域名、路径和协议，过期条目不发送', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-post-cookie-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'fixture.txt');
    fs.writeFileSync(file, [
        '.x.com\tTRUE\t/\tTRUE\t0\tauth_token\tfixture-token',
        'x.com\tFALSE\t/private\tFALSE\t0\tpath_cookie\tprivate',
        '.x.com\tTRUE\t/\tFALSE\t1\texpired\told',
        '.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tfixture-instagram'
    ].join('\n'));
    assert.equal(cookieHeader(file, 'https://x.com/user/status/1'), 'auth_token=fixture-token');
    assert.equal(cookieHeader(file, 'https://pbs.twimg.com/media/a.jpg'), '');
    assert.equal(cookieHeader(file, 'https://x.com.evil.test/private'), '');
    assert.equal(cookieHeader(file, 'http://x.com/user/status/1'), '');
    assert.equal(cookieHeader(file, 'https://x.com/private/a'), 'auth_token=fixture-token; path_cookie=private');
    assert.equal(cookieHeader(file, 'https://x.com/private-a'), 'auth_token=fixture-token');
});

test('结构化帖子优先正文与原图，OG作为有限摘要兜底且去重图片', () => {
    const metadata = extractPostMetadata(`<meta content="OG &amp; title" property="og:title"><meta property="og:description" content="摘要"><meta property="og:image" content="https://cdn.example/fallback.jpg"><script type="application/ld+json">${JSON.stringify({ '@type': 'SocialMediaPosting', headline: '正文标题', articleBody: '完整正文\n第二行', author: { name: '作者' }, image: ['/photo.jpg', '/photo.jpg'], datePublished: '2026-10-27' })}</script>`, 'https://x.com/user/status/1');
    assert.equal(metadata.title, '正文标题');
    assert.equal(metadata.body, '完整正文\n第二行');
    assert.equal(metadata.author, '作者');
    assert.deepEqual(metadata.images, ['https://x.com/photo.jpg']);
    assert.equal(metadata.structuredBody, true);
});

test('Markdown使用已登记的隧道资源引用，不保留外站媒体热链或执行源帖HTML', () => {
    const markdown = buildPostMarkdown({ source: { sourceUrl: 'https://x.com/u/status/1' }, metadata: { title: '<script>x</script>', body: '<img src=x onerror=x>\n**literal**', author: '作者' },
        media: [{ sessionId: 'tunnel-a', messageId: 'record-1', file: { id: 'photo-1', name: '照片.png', type: 'image/png' } },
            { sessionId: 'tunnel-a', messageId: 'record-2', file: { id: 'video-1', name: '视频.mp4', type: 'video/mp4' } }] });
    assert.match(markdown, /!\[照片.png\]\(tunnel-blob:tunnel-a\/record-1\/photo-1\)/);
    assert.match(markdown, /<video controls src="tunnel-blob:tunnel-a\/record-2\/video-1"><\/video>/);
    assert.match(markdown, /\\<script\\>/);
    assert.doesNotMatch(markdown, /https:\/\/cdn/);
});

function publisherFixture(overrides = {}) {
    const source = { id: 'source', messageId: 'record', sourceUrl: 'https://x.com/u/status/1' };
    const original = { id: 'record', snsSources: [source], snsMediaItems: [{ id: 'video', sourceId: 'source', mediaKind: 'video' }] };
    const messages = new Map([['record', original]]), published = [];
    let allowed = true, acquisitions = 0;
    const publisher = createSnsPostPublisher({
        authorize() { if (!allowed) throw Error('permission-denied'); },
        record: (_sid, id) => messages.get(id),
        inspect: async () => ({ title: '帖子', body: '正文', images: [] }),
        acquire: async () => { acquisitions++; return { id: 'generated-video', type: 'file', fileInfo: { id: 'video-asset', name: '视频.mp4', type: 'video/mp4' } }; },
        image: async () => { throw Error('unexpected-image'); },
        publish: async (_sid, message) => { published.push(message); messages.set(message.id, message); },
        existing: () => published[0],
        sender: () => ({ sender: 'sns-server', senderName: 'SNS 媒体文件' }),
        ...overrides
    });
    return { publisher, messages, published, revoke: () => { allowed = false; }, acquisitions: () => acquisitions };
}
const args = { sessionId: 'tunnel', messageId: 'record', sourceId: 'source', deviceId: 'device' };

test('重复点击及完成后重试复用同一帖子任务，媒体成功后才发布一次Markdown', async () => {
    const fixture = publisherFixture();
    const first = fixture.publisher.start(args), second = fixture.publisher.start(args);
    assert.equal(first, second);
    const message = await first.promise;
    assert.equal(fixture.published.length, 1);
    assert.equal(fixture.acquisitions(), 1);
    assert.equal(message.sender, 'sns-server');
    assert.match(message.markdown, /tunnel-blob:tunnel\/generated-video\/video-asset/);
    const third = fixture.publisher.start(args);
    assert.equal(third.started, false);
    assert.equal((await third.promise).id, message.id);
});

test('任一媒体失败或长等待后撤销权限都不发布完成记录', async () => {
    const failed = publisherFixture({ acquire: async () => { throw Error('upstream-failed'); } });
    await assert.rejects(failed.publisher.start(args).promise, /upstream-failed/);
    assert.equal(failed.published.length, 0);
    let release;
    const delayed = publisherFixture({ inspect: () => new Promise(resolve => { release = resolve; }) });
    const job = delayed.publisher.start(args);
    await new Promise(resolve => setImmediate(resolve));
    delayed.revoke(); release({ title: '帖子', body: '正文', images: [] });
    await assert.rejects(job.promise, /permission-denied/);
    assert.equal(delayed.published.length, 0);
});

test('帖子图片通过SNS身份登记目标隧道；重试使用相同文件身份且不重复下载', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-post-asset-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const records = new Map(); let reads = 0, registrations = 0;
    const publish = createSnsPostImagePublisher({ assetDir: dir,
        record: (_sid, id) => records.get(id), registerAsset: asset => { registrations++; assert.equal(asset.sessionId, 'tunnel-a'); assert.equal(asset.source, 'sns-post-image'); },
        fileInfo: asset => ({ id: asset.id, name: asset.name, type: asset.type, isServerAsset: true }),
        sender: () => ({ sender: 'sns-server' }),
        publish: (_sid, message) => records.set(message.id, message),
        readImage: async url => { reads++; return { data: Buffer.from('fixture-image'), type: 'image/png', url }; }
    });
    const source = { messageId: 'post', id: 'source', sourceUrl: 'https://x.com/u/status/1' };
    const first = await publish('tunnel-a', source, 'https://cdn.example/photo.png', 0);
    const second = await publish('tunnel-a', source, 'https://cdn.example/photo.png', 0);
    assert.equal(first.id, second.id);
    assert.equal(first.sender, 'sns-server');
    assert.equal(reads, 1); assert.equal(registrations, 1);
    assert.ok(fs.existsSync(path.join(dir, first.fileInfo.id)));
});

test('图片响应不接受HTML/SVG伪装，也不转发任何Cookie到媒体CDN', async () => {
    await assert.rejects(readPostImage('https://cdn.example/photo.png', { request: async (_url, options) => {
        assert.equal(options.cookie, undefined);
        return { data: Buffer.from('<svg onload="x">'), type: 'image/png' };
    } }), /IMAGE_INVALID/);
    const image = await readPostImage('https://cdn.example/photo.png', { request: async () => ({ data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), type: 'image/png' }) });
    assert.equal(image.type, 'image/png');
});

test('帖子适配器从旧的解析失败记录恢复视频与图片，所有引用都指向同一目标隧道的已发布文件', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-post-integration-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = { id: 'source', messageId: 'post', sourceUrl: 'https://x.com/u/status/1' };
    const original = { id: 'post', snsSources: [source], snsMediaItems: [] };
    const current = { history: [{ message: original }] };
    const find = (_sid, id) => current.history.find(entry => entry.message.id === id)?.message;
    const publish = (_sid, message) => current.history.push({ message });
    const service = createTunnelSnsPostPublisher({ assetDir: dir, session: () => current, record: find, authorize() {}, publish,
        sender: () => ({ sender: 'sns-server', senderName: 'SNS 媒体文件' }),
        metadata: async () => ({ title: '原帖', description: '完整的帖子文本', formats: [{ vcodec: 'h264', acodec: 'aac' }] }),
        request: async () => ({ type: 'text/html', data: Buffer.from('<meta property="og:image" content="https://cdn.example/photo.png">') }),
        buildItem: (messageId, from) => ({ id: 'video', sourceId: from.id, messageId, mediaKind: 'video' }), update() {},
        acquire: async (sid, messageId, mediaItemId) => {
            assert.equal(find(sid, messageId).snsMediaItems[0].id, mediaItemId);
            const message = { id: 'video-record', type: 'file', fileInfo: { id: 'video-asset', name: 'video.mp4', type: 'video/mp4', size: 9 } };
            await publish(sid, message);
            return { generatedMessageId: message.id };
        },
        registerAsset() {}, fileInfo: asset => ({ id: asset.id, name: asset.name, type: asset.type, size: asset.size }),
        readImage: async url => ({ url, type: 'image/png', data: Buffer.from('fixture-image') })
    });
    const message = await service.start({ sessionId: 'tunnel-a', messageId: 'post', sourceId: 'source', deviceId: 'device' }).promise;
    const refs = [...message.markdown.matchAll(/tunnel-blob:([\w-]+)\/([\w.-]+)\/([\w.-]+)/g)];
    assert.equal(new Set(refs.map(match => match[0])).size, 2);
    for (const match of refs) {
        assert.equal(match[1], 'tunnel-a');
        assert.equal(find(match[1], match[2]).fileInfo.id, match[3]);
    }
    assert.equal(current.history.filter(entry => entry.message.type === 'markdown').length, 1);
});
