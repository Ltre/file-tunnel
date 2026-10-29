'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

const SOURCE_DOMAINS = ['youtube.com', 'youtu.be', 'tiktok.com', 'facebook.com', 'fb.watch', 'instagram.com',
    'threads.com', 'threads.net', 'line.me', 'twitter.com', 'x.com', 'bilibili.com', 'b23.tv', 'music.163.com', '163cn.tv', '163cn.link'];
const MAX_IMAGES = 20;
const MAX_POST_BYTES = 256 * 1024;
const safeHttpUrl = value => {
    try {
        const url = new URL(String(value || ''));
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
            (url.port && !['80', '443'].includes(url.port))) return '';
        return url.href;
    } catch (_) { return ''; }
};
const sourceUrl = value => {
    const url = safeHttpUrl(value);
    if (!url) throw Error('SNS_POST_URL_UNSUPPORTED');
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    if (!SOURCE_DOMAINS.some(domain => host === domain || host.endsWith('.' + domain))) throw Error('SNS_POST_URL_UNSUPPORTED');
    return url;
};

function publicAddress(address) {
    const value = String(address || '').toLowerCase();
    if (net.isIPv4(value)) {
        const [a, b] = value.split('.').map(Number);
        return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) &&
            !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0)) &&
            !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19, 51].includes(b)) &&
            !(a === 203 && b === 0);
    }
    // Only globally routable IPv6. Embedded IPv4 forms are deliberately rejected.
    return net.isIPv6(value) && /^[23][0-9a-f]{3}:/.test(value) && !value.startsWith('2001:db8:') && !value.includes('.');
}

function cookieHeader(filePath, pageUrl) {
    if (!filePath) return '';
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { return ''; }
    const url = new URL(pageUrl), now = Date.now() / 1000;
    return content.split(/\r?\n/).flatMap(line => {
        if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) return [];
        const [rawDomain, subdomains, cookiePath, secure, expires, name, value] = line.replace(/^#HttpOnly_/, '').split('\t');
        const domain = String(rawDomain || '').replace(/^\./, '').toLowerCase();
        if (!name || !value || /[\r\n;]/.test(name + value) || (Number(expires) > 0 && Number(expires) <= now)) return [];
        if (url.hostname !== domain && !(subdomains === 'TRUE' && url.hostname.endsWith('.' + domain))) return [];
        const prefix = cookiePath || '/';
        if (url.pathname !== prefix && !url.pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')) return [];
        if (secure === 'TRUE' && url.protocol !== 'https:') return [];
        return [name + '=' + value];
    }).join('; ');
}

function configuredProxy(url, env = process.env) {
    // Mirror buildYtDlpEnv: fill scheme proxies from DR2T_PROXY only when absent,
    // and retain ALL_PROXY as the fallback. Python prefers lowercase variables.
    // No proxy credentials enter destination headers or diagnostics.
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const bypass = String(env.no_proxy || env.NO_PROXY || '').split(',').some(value => {
        const item = value.trim().toLowerCase();
        if (item === '*') return true;
        const [name, configuredPort] = item.split(':');
        const domain = String(name || '').replace(/^\./, '');
        return domain && (!configuredPort || configuredPort === port) && (url.hostname === domain || url.hostname.endsWith('.' + domain));
    });
    if (bypass) return '';
    const base = env.DR2T_PROXY || env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || '';
    const fallback = env.all_proxy || env.DR2T_ALL_PROXY || env.ALL_PROXY || base;
    const scheme = url.protocol === 'https:' ? env.https_proxy || env.HTTPS_PROXY : env.http_proxy || env.HTTP_PROXY;
    return String(scheme || base || fallback).trim();
}

function publicLookup(hostname, timeoutMs) {
    const host = hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) return publicAddress(host) ? Promise.resolve([{ address: host, family: net.isIP(host) }]) : Promise.reject(Error('SNS_POST_ADDRESS_DENIED'));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('SNS_POST_TIMEOUT')), timeoutMs); timer.unref?.();
        dns.lookup(host, { all: true, verbatim: true }, (error, addresses) => {
            clearTimeout(timer);
            if (error) return reject(error);
            if (!addresses.length || addresses.some(item => !publicAddress(item.address))) return reject(Error('SNS_POST_ADDRESS_DENIED'));
            resolve(addresses);
        });
    });
}

function connectHttpProxy(proxy, target, port, timeoutMs) {
    return new Promise((resolve, reject) => {
        const address = target.family === 6 ? '[' + target.address + ']' : target.address;
        const headers = { Host: address + ':' + port };
        if (proxy.username || proxy.password) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
        const request = (proxy.protocol === 'https:' ? https : http).request(proxy, { method: 'CONNECT', path: address + ':' + port, headers, agent: false });
        const timer = setTimeout(() => request.destroy(Error('SNS_POST_PROXY_TIMEOUT')), timeoutMs); timer.unref?.();
        request.on('connect', (response, socket, head) => {
            clearTimeout(timer);
            if (response.statusCode !== 200) { socket.destroy(); return reject(Error('SNS_POST_PROXY_REJECTED')); }
            if (head.length) { socket.destroy(); return reject(Error('SNS_POST_PROXY_INVALID')); }
            resolve(socket);
        });
        request.on('error', error => { clearTimeout(timer); reject(error); });
        request.end();
    });
}

function ipv6Bytes(address) {
    const [left, right = ''] = address.split('::');
    const begin = left ? left.split(':') : [], end = right ? right.split(':') : [];
    const groups = [...begin, ...Array(Math.max(0, 8 - begin.length - end.length)).fill('0'), ...end];
    const result = Buffer.alloc(16);
    groups.forEach((group, index) => result.writeUInt16BE(parseInt(group, 16), index * 2));
    return result;
}

function connectSocksProxy(proxy, target, port, timeoutMs) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port) || 1080 });
        let buffer = Buffer.alloc(0), pending = null, finished = false;
        const fail = error => {
            if (finished) return;
            finished = true; clearTimeout(timer); socket.destroy();
            if (pending) { const waiter = pending; pending = null; waiter.reject(error); }
            reject(error);
        };
        const pump = () => {
            if (!pending || buffer.length < pending.bytes) return;
            const { bytes, resolve: done } = pending; pending = null;
            const result = buffer.subarray(0, bytes); buffer = buffer.subarray(bytes); done(result);
        };
        const receive = chunk => { buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 4096) return fail(Error('SNS_POST_PROXY_INVALID')); pump(); };
        const take = bytes => new Promise((done, error) => { pending = { bytes, resolve: done, reject: error }; pump(); });
        const timer = setTimeout(() => fail(Error('SNS_POST_PROXY_TIMEOUT')), timeoutMs); timer.unref?.();
        socket.on('data', receive); socket.on('error', fail); socket.on('end', () => fail(Error('SNS_POST_PROXY_CLOSED')));
        socket.once('connect', async () => {
            try {
                const user = Buffer.from(decodeURIComponent(proxy.username)), password = Buffer.from(decodeURIComponent(proxy.password));
                if (user.length > 255 || password.length > 255) throw Error('SNS_POST_PROXY_INVALID');
                socket.write(user.length || password.length ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
                const hello = await take(2);
                if (hello[0] !== 5 || ![0, 2].includes(hello[1])) throw Error('SNS_POST_PROXY_REJECTED');
                if (hello[1] === 2) {
                    if (!user.length && !password.length) throw Error('SNS_POST_PROXY_REJECTED');
                    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]));
                    const auth = await take(2);
                    if (auth[0] !== 1 || auth[1] !== 0) throw Error('SNS_POST_PROXY_REJECTED');
                }
                const address = target.family === 6 ? ipv6Bytes(target.address) : Buffer.from(target.address.split('.').map(Number));
                const portBytes = Buffer.alloc(2); portBytes.writeUInt16BE(port);
                // Even socks5h uses the already checked IP; the proxy cannot
                // re-resolve the source hostname to a private network address.
                socket.write(Buffer.concat([Buffer.from([5, 1, 0, target.family === 6 ? 4 : 1]), address, portBytes]));
                const reply = await take(4);
                if (reply[0] !== 5 || reply[1] !== 0 || ![1, 3, 4].includes(reply[3])) throw Error('SNS_POST_PROXY_REJECTED');
                await take(reply[3] === 1 ? 6 : reply[3] === 4 ? 18 : (await take(1))[0] + 2);
                if (finished) return;
                finished = true; clearTimeout(timer);
                socket.removeListener('data', receive); socket.removeListener('error', fail);
                if (buffer.length) socket.unshift(buffer);
                resolve(socket);
            } catch (error) { fail(error); }
        });
    });
}

async function proxySocket(value, url, addresses, timeoutMs) {
    let proxy;
    try { proxy = new URL(value); } catch (_) { throw Error('SNS_POST_PROXY_INVALID'); }
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxy.protocol) || proxy.hash || proxy.pathname && proxy.pathname !== '/') throw Error('SNS_POST_PROXY_UNSUPPORTED');
    const target = addresses.find(address => address.family === 4) || addresses[0], port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const socket = proxy.protocol.startsWith('socks5') ? await connectSocksProxy(proxy, target, port, timeoutMs) : await connectHttpProxy(proxy, target, port, timeoutMs);
    if (url.protocol === 'http:') return socket;
    return tls.connect({ socket, servername: url.hostname, rejectUnauthorized: true });
}

/** Public-DNS-pinned request: page/redirect URLs are constrained separately; cookies never follow to a CDN. */
async function readPublicUrl(value, { maxBytes = 2 * 1024 * 1024, cookie = '', timeoutMs = 20000, proxy: proxyOverride } = {}) {
    const href = safeHttpUrl(value);
    if (!href) return Promise.reject(Error('SNS_POST_URL_UNSUPPORTED'));
    const url = new URL(href);
    const started = Date.now(), addresses = await publicLookup(url.hostname, timeoutMs);
    const proxy = proxyOverride === undefined ? configuredProxy(url) : proxyOverride;
    const connection = proxy ? await proxySocket(proxy, url, addresses, Math.max(1, timeoutMs - (Date.now() - started))) : null;
    return new Promise((resolve, reject) => {
        let timer;
        const finish = (error, value) => { clearTimeout(timer); if (error) { connection?.destroy(); reject(error); } else resolve(value); };
        const request = (url.protocol === 'https:' ? https : http).request(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 Drop2Tunnel-SNS-Post', Accept: 'text/html,application/json,image/*;q=0.8', ...(cookie ? { Cookie: cookie } : {}) },
            ...(connection ? { createConnection: () => connection } : { agent: false }),
            lookup(host, options, callback) {
                if (options.all) return callback(null, addresses);
                callback(null, addresses[0].address, addresses[0].family);
            }
        }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                try { return finish(null, { redirect: new URL(response.headers.location, url).href }); }
                catch (_) { return finish(Error('SNS_POST_URL_UNSUPPORTED')); }
            }
            if (response.statusCode !== 200) {
                response.resume();
                return finish(Error('SNS_POST_HTTP_' + response.statusCode));
            }
            const chunks = []; let bytes = 0;
            response.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > maxBytes) { response.destroy(Error('SNS_POST_RESOURCE_TOO_LARGE')); return; }
                chunks.push(chunk);
            });
            response.on('error', finish);
            response.on('end', () => finish(null, { data: Buffer.concat(chunks), type: String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase() }));
        });
        timer = setTimeout(() => request.destroy(Error('SNS_POST_TIMEOUT')), Math.max(1, timeoutMs - (Date.now() - started)));
        timer.unref?.();
        request.on('error', finish);
        request.end();
    });
}

function decodeEntities(value) {
    return String(value || '').replace(/&(?:quot|apos|amp|lt|gt|#(\d+)|#x([0-9a-f]+));/gi, (match, decimal, hex) => {
        if (decimal || hex) { const point = parseInt(decimal || hex, decimal ? 10 : 16); return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''; }
        return ({ '&quot;': '"', '&apos;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>' })[match.toLowerCase()] || match;
    });
}
function extractPostMetadata(html, pageUrl) {
    const metas = new Map();
    for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
        const attrs = {};
        for (const attr of match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[attr[1].toLowerCase()] = decodeEntities(attr[2] ?? attr[3] ?? attr[4]);
        const name = String(attrs.property || attrs.name || '').toLowerCase();
        if (name && attrs.content) { const list = metas.get(name) || []; list.push(attrs.content); metas.set(name, list); }
    }
    const first = key => metas.get(key)?.[0] || '';
    let article = null;
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach(visit); return; }
        const types = [].concat(value['@type'] || []);
        if (types.some(type => /^(?:SocialMediaPosting|Article|BlogPosting|NewsArticle|VideoObject|ImageObject|MusicRecording)$/.test(type))) {
            if (!article || value.articleBody || !article.articleBody && value.description) article = value;
        }
        if (value['@graph']) visit(value['@graph']);
        if (value.mainEntity) visit(value.mainEntity);
    };
    for (const script of String(html).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
        try { visit(JSON.parse(script[1])); } catch (_) { /* Invalid structured data does not make the metadata unusable. */ }
    }
    const imageValues = [].concat(article?.image || []).map(image => typeof image === 'string' ? image : image?.contentUrl || image?.url).filter(Boolean);
    const images = [...new Set((imageValues.length ? imageValues : metas.get('og:image') || []).map(value => {
        try { return safeHttpUrl(new URL(value, pageUrl).href); } catch (_) { return ''; }
    }).filter(Boolean))];
    const author = [].concat(article?.author || []).map(value => typeof value === 'string' ? value : value?.name || '').filter(Boolean).join(', ');
    return {
        title: String(article?.headline || article?.name || first('og:title') || first('twitter:title') || '').trim().slice(0, 1000),
        body: String(article?.articleBody || article?.description || first('og:description') || first('twitter:description') || '').trim().slice(0, 100000),
        author: String(author || first('author') || first('article:author')).slice(0, 1000),
        publishedAt: String(article?.datePublished || first('article:published_time')).slice(0, 100),
        images,
        structuredBody: Boolean(article?.articleBody)
    };
}

async function readWebPost(value, { cookieFileForUrl = () => '', request = readPublicUrl } = {}) {
    let url = sourceUrl(value);
    for (let redirects = 0; redirects <= 4; redirects++) {
        const response = await request(url, { maxBytes: 2 * 1024 * 1024, cookie: cookieHeader(cookieFileForUrl(url), url) });
        if (response.redirect) { url = sourceUrl(response.redirect); continue; }
        if (response.type && !/^(?:text\/html|application\/xhtml\+xml)$/.test(response.type)) throw Error('SNS_POST_PAGE_INVALID');
        return { ...extractPostMetadata(response.data.toString('utf8'), url), url };
    }
    throw Error('SNS_POST_REDIRECT_LIMIT');
}

function twitterPostId(value) {
    const url = new URL(sourceUrl(value));
    if (!/^(?:(?:www|mobile|m)\.)?(?:twitter|x)\.com$/i.test(url.hostname)) return '';
    return url.pathname.match(/^\/(?:[^/]+\/status|i\/web\/status|statuses)\/(\d{1,24})(?:\/|$)/)?.[1] || '';
}

async function readTwitterPost(value, { request = readPublicUrl } = {}) {
    const id = twitterPostId(value);
    if (!id) return null;
    // X's public embed response retains photo entities which the video extractor
    // intentionally omits. Same endpoint/token as yt-dlp's Twitter syndication adapter:
    // https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/twitter.py
    const url = new URL('https://cdn.syndication.twimg.com/tweet-result');
    url.searchParams.set('id', id);
    url.searchParams.set('token', ((Number(id) / 1e15) * Math.PI).toString(36).replace(/[0.]/g, ''));
    const response = await request(url.href, { maxBytes: 1024 * 1024, timeoutMs: 8000 });
    if (response.redirect || response.type && !/^application\/json$/.test(response.type)) throw Error('SNS_POST_PAGE_INVALID');
    let post;
    try { post = JSON.parse(response.data.toString('utf8')); } catch (_) { throw Error('SNS_POST_PAGE_INVALID'); }
    if (!post || typeof post !== 'object' || String(post.id_str || '') !== id) throw Error('SNS_POST_CONTENT_UNAVAILABLE');
    const photos = (Array.isArray(post.mediaDetails) ? post.mediaDetails.filter(item => item?.type === 'photo') : [])
        .concat(Array.isArray(post.photos) ? post.photos : []);
    const images = [...new Set(photos.map(item => safeHttpUrl(item?.media_url_https || item?.url)).filter(value => {
        if (!value) return false;
        const image = new URL(value);
        return value.length <= 4096 && image.protocol === 'https:' && image.hostname === 'pbs.twimg.com' && image.pathname.startsWith('/media/');
    }))];
    if (images.length > MAX_IMAGES) throw Error('SNS_POST_IMAGE_LIMIT');
    const text = typeof post.text === 'string' ? post.text.trim().slice(0, 100000) : '';
    return { title: text.slice(0, 1000), body: text,
        author: typeof post.user?.name === 'string' ? post.user.name.slice(0, 1000) : '',
        publishedAt: typeof post.created_at === 'string' ? post.created_at.slice(0, 100) : '',
        images, structuredBody: Boolean(text), url: value };
}

async function readSnsPostContent(value, options = {}) {
    const [page, embedded] = await Promise.allSettled([readWebPost(value, options), readTwitterPost(value, options)]);
    let webpage = page.status === 'fulfilled' ? page.value : {};
    if (/(?:log\s*in|sign\s*in|security check|just a moment|access denied|登录|安全验证|验证码)/i.test(webpage.title || '') && !webpage.structuredBody) webpage = {};
    const twitter = embedded.status === 'fulfilled' ? embedded.value : null;
    if (twitter?.body || twitter?.images.length) return { ...webpage, ...twitter, images: twitter.images.length ? twitter.images : webpage.images || [] };
    if (page.status === 'fulfilled') return webpage;
    throw page.reason;
}

async function readPostImage(value, { request = readPublicUrl } = {}) {
    let url = safeHttpUrl(value);
    for (let redirects = 0; redirects <= 4; redirects++) {
        const response = await request(url, { maxBytes: 20 * 1024 * 1024 });
        if (response.redirect) { url = safeHttpUrl(response.redirect); if (!url) throw Error('SNS_POST_URL_UNSUPPORTED'); continue; }
        // SVG is active document content, so only raster images enter SNS assets.
        const body = response.data;
        const raster = response.type === 'image/jpeg' ? body[0] === 0xff && body[1] === 0xd8
            : response.type === 'image/png' ? body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                : response.type === 'image/gif' ? /^GIF8[79]a/.test(body.subarray(0, 6).toString('ascii'))
                    : response.type === 'image/webp' ? body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP'
                        : response.type === 'image/avif' && body.subarray(4, 8).toString('ascii') === 'ftyp' && /avif|avis/.test(body.subarray(8, 40).toString('ascii'));
        if (!raster) throw Error('SNS_POST_IMAGE_INVALID');
        return { data: response.data, type: response.type, url };
    }
    throw Error('SNS_POST_REDIRECT_LIMIT');
}

function createSnsPostImagePublisher({ assetDir, record, registerAsset, fileInfo, publish, sender, authorize = () => {}, readImage = readPostImage }) {
    return async (sessionId, source, imageUrl, index, deviceId) => {
        authorize(sessionId, deviceId);
        const key = [sessionId, source.messageId, source.id, imageUrl, index].join('\n');
        const digest = crypto.createHash('sha256').update(key).digest();
        const assetId = digest.subarray(0, 16).toString('base64url');
        const hex = digest.subarray(16).toString('hex');
        const messageId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
        const previous = record(sessionId, messageId);
        if (previous?.fileInfo?.id === assetId && fs.existsSync(path.join(assetDir, assetId))) return previous;
        const image = await readImage(imageUrl);
        authorize(sessionId, deviceId);
        const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' })[image.type];
        if (!ext) throw Error('SNS_POST_IMAGE_INVALID');
        fs.mkdirSync(assetDir, { recursive: true });
        const target = path.join(assetDir, assetId), temporary = target + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
        try { fs.writeFileSync(temporary, image.data); fs.renameSync(temporary, target); }
        finally { try { fs.unlinkSync(temporary); } catch (_) {} }
        const asset = { id: assetId, path: target, name: 'sns-post-' + (index + 1) + '.' + ext, type: image.type,
            size: image.data.length, sessionId, createdAt: Date.now(), source: 'sns-post-image', sourceUrl: image.url,
            sourceMessageId: source.messageId, snsMediaItemId: source.id, mediaKind: 'image' };
        // These image assets have no yt-dlp acquisition task. The existing SNS
        // cleanup rule intentionally retains non-refetchable assets after peer caching.
        registerAsset(asset);
        const message = { id: messageId, type: 'file', fileInfo: fileInfo(asset), timestamp: Date.now(), ...sender(), sessionId,
            snsAcquisition: { source: 'sns-post-image', sourceMessageId: source.messageId, sourceId: source.id, sourceUrl: source.sourceUrl } };
        await publish(sessionId, message, deviceId);
        return message;
    };
}

async function inspectSnsPost(source, { runMetadata, cookieFileForUrl, request } = {}) {
    const [parsed, page] = await Promise.allSettled([
        runMetadata(sourceUrl(source.sourceUrl), { noPlaylist: true, flatPlaylist: false, ignoreNoFormats: true,
            allowIgnoreNoFormatsFallback: false, timeoutMs: 45000, operation: 'sns-post-markdown-metadata' }),
        readSnsPostContent(source.sourceUrl, { cookieFileForUrl, request })
    ]);
    const metadata = parsed.status === 'fulfilled' ? parsed.value || {} : {};
    let webpage = page.status === 'fulfilled' ? page.value : {};
    if (/(?:log\s*in|sign\s*in|security check|just a moment|access denied|登录|安全验证|验证码)/i.test(webpage.title || '') && !webpage.structuredBody) webpage = {};
    const entries = Array.isArray(metadata.entries) ? metadata.entries.filter(Boolean) : [];
    if (entries.length > 40) throw Error('SNS_POST_MEDIA_LIMIT');
    const description = String(metadata.description || metadata.caption || entries.map(item => item.description || item.caption || '').filter(Boolean).join('\n\n')).trim();
    const body = description || webpage.body || '';
    // A login/anti-bot page's generic title must not become a successful empty post.
    if (!body && !webpage.images?.length && parsed.status === 'rejected') throw Error('SNS_POST_CONTENT_UNAVAILABLE');
    return {
        title: String(metadata.title || metadata.fulltitle || webpage.title || source.title || '').slice(0, 1000),
        body,
        author: String(metadata.uploader || metadata.channel || metadata.creator || webpage.author || '').slice(0, 1000),
        publishedAt: String(metadata.upload_date || metadata.release_date || webpage.publishedAt || '').slice(0, 100),
        images: webpage.images || [],
        // OpenGraph is a preview, not a promise that a long article was fully extracted.
        partial: !description && !webpage.structuredBody,
        mediaMetas: entries.length ? entries : [metadata],
        mediaParsed: parsed.status === 'fulfilled'
    };
}

const markdownText = value => String(value || '').replace(/\r\n?/g, '\n').replace(/([\\`*_[\]<>#])/g, '\\$1');
function buildPostMarkdown({ source, metadata, media, notes = [] }) {
    const lines = [], title = String(metadata.title || source.title || source.sourceUrl || '').trim();
    if (title) lines.push('# ' + markdownText(title).replace(/\n/g, ' '), '');
    if (metadata.author) lines.push(markdownText(metadata.author), '');
    if (metadata.publishedAt) lines.push(markdownText(metadata.publishedAt), '');
    if (metadata.body) lines.push(markdownText(metadata.body), '');
    lines.push('[' + markdownText(source.sourceUrl) + '](' + encodeURI(sourceUrl(source.sourceUrl)).replace(/\(/g, '%28').replace(/\)/g, '%29') + ')', '');
    for (const { sessionId, messageId, file } of media) {
        if (![sessionId, messageId, file?.id].every(value => /^[\w.-]+$/.test(String(value || '')))) throw Error('SNS_POST_REFERENCE_INVALID');
        const ref = 'tunnel-blob:' + sessionId + '/' + messageId + '/' + file.id;
        if (String(file.type || '').startsWith('image/')) lines.push('![' + markdownText(file.name) + '](' + ref + ')', '');
        else if (/^(?:video|audio)\//.test(String(file.type || ''))) {
            const tag = String(file.type).startsWith('audio/') ? 'audio' : 'video';
            lines.push('<' + tag + ' controls src="' + ref + '"></' + tag + '>', '', '[' + markdownText(file.name) + '](' + ref + ')', '');
        } else lines.push('[' + markdownText(file.name) + '](' + ref + ')', '');
    }
    for (const note of notes) lines.push('> ' + markdownText(note).replace(/\n/g, '\n> '), '');
    const body = lines.join('\n').trim();
    if (Buffer.byteLength(body) > MAX_POST_BYTES) throw Error('SNS_POST_CONTENT_TOO_LARGE');
    return body;
}

/** All external operations are injected. Authorization is checked again after every long wait. */
function createSnsPostPublisher({ authorize, record, inspect, prepare = () => {}, acquire, image, publish, existing, sender, onError = () => {} }) {
    const jobs = new Map();
    function start({ sessionId, messageId, sourceId, deviceId }) {
        authorize(sessionId, deviceId);
        const sourceRecord = record(sessionId, messageId);
        const source = sourceRecord?.snsSources?.find(item => item?.id === sourceId);
        if (!source) throw Error('SNS_POST_SOURCE_MISSING');
        sourceUrl(source.sourceUrl);
        const key = [sessionId, messageId, sourceId].join(':');
        const found = existing(sessionId, messageId, sourceId);
        if (found) return { id: found.id, started: false, promise: Promise.resolve(found) };
        if (jobs.has(key)) return jobs.get(key);
        if (jobs.size >= 16) throw Error('SNS_POST_BUSY');
        const id = crypto.randomUUID();
        const job = { id, started: true };
        job.promise = Promise.resolve().then(async () => {
            const metadata = await inspect(source);
            authorize(sessionId, deviceId);
            await prepare(sessionId, messageId, source, metadata);
            authorize(sessionId, deviceId);
            const current = record(sessionId, messageId);
            if (!current?.snsSources?.some(item => item.id === sourceId)) throw Error('SNS_POST_SOURCE_MISSING');
            const media = [], notes = [];
            const items = (current.snsMediaItems || []).filter(item => item?.sourceId === sourceId && item.mediaKind !== 'unsupported' && item.mediaKind !== 'none');
            if (items.length > 40) throw Error('SNS_POST_MEDIA_LIMIT');
            if (!metadata.body && !metadata.title && !items.length && !metadata.images?.length) throw Error('SNS_POST_CONTENT_UNAVAILABLE');
            for (const item of items) {
                const generated = await acquire(sessionId, messageId, item.id);
                authorize(sessionId, deviceId);
                const files = generated?.type === 'file' ? [generated.fileInfo] : generated?.collection?.files || [];
                if (!files.length) throw Error('SNS_POST_MEDIA_UNAVAILABLE');
                for (const file of files) media.push({ sessionId, messageId: generated.id, file });
            }
            const pictures = metadata.images || [];
            if (pictures.length > MAX_IMAGES) throw Error('SNS_POST_IMAGE_LIMIT');
            for (let index = 0; index < pictures.length; index++) {
                const generated = await image(sessionId, source, pictures[index], index, deviceId);
                authorize(sessionId, deviceId);
                if (!generated?.fileInfo?.id) throw Error('SNS_POST_MEDIA_UNAVAILABLE');
                media.push({ sessionId, messageId: generated.id, file: generated.fileInfo });
            }
            if (metadata.partial) notes.push('平台仅返回了摘要；本文不保证包含原帖全部内容，请结合原帖链接核对。');
            if (metadata.note) notes.push(metadata.note);
            const markdown = buildPostMarkdown({ source, metadata, media, notes });
            authorize(sessionId, deviceId);
            if (!record(sessionId, messageId)) throw Error('SNS_POST_SOURCE_MISSING');
            const previous = existing(sessionId, messageId, sourceId);
            if (previous) return previous;
            const message = { id, type: 'markdown', markdown, timestamp: Date.now(), ...sender(), sessionId,
                snsAcquisition: { source: 'sns-post-markdown', sourceMessageId: messageId, sourceId, sourceUrl: source.sourceUrl } };
            await publish(sessionId, message, deviceId);
            return message;
        }).finally(() => jobs.delete(key));
        // A disconnected caller does not create an unhandled rejection or duplicate the job.
        job.promise.catch(error => onError(error));
        jobs.set(key, job);
        return job;
    }
    return { start };
}

function createTunnelSnsPostPublisher(options) {
    const { record, session, authorize, publish, sender } = options;
    return createSnsPostPublisher({
        authorize, record, publish, sender,
        existing: (sessionId, messageId, sourceId) => (session(sessionId)?.history || []).map(entry => entry.message || entry)
            .find(message => message?.type === 'markdown' && message.snsAcquisition?.source === 'sns-post-markdown' &&
                message.snsAcquisition.sourceMessageId === messageId && message.snsAcquisition.sourceId === sourceId),
        inspect: source => inspectSnsPost(source, { runMetadata: options.metadata, cookieFileForUrl: options.cookieFileForUrl, request: options.request }),
        prepare(sessionId, messageId, source, metadata) {
            if (!metadata.mediaParsed && !metadata.images?.length) return;
            const message = record(sessionId, messageId);
            const currentSource = message?.snsSources?.find(item => item.id === source.id);
            if (!currentSource) throw Error('SNS_POST_SOURCE_MISSING');
            const fresh = metadata.mediaParsed ? metadata.mediaMetas.flatMap((entry, index) => {
                const formats = Array.isArray(entry.formats) ? entry.formats : [];
                const video = formats.some(format => format.vcodec && format.vcodec !== 'none' || Number(format.width) > 0 || Number(format.height) > 0);
                const audio = formats.some(format => format.acodec && format.acodec !== 'none');
                const direct = safeHttpUrl(entry.url) && /^(?:mp4|webm|mov|mkv|m4a|mp3|aac|flac|opus|ogg)$/i.test(entry.ext || '');
                if (!video && !audio && !direct) return [];
                const item = options.buildItem(messageId, source, entry, index);
                if (!video && audio && item.mediaKind !== 'song') item.mediaKind = 'audio';
                item.sourceType = metadata.mediaMetas.length > 1 ? 'collection' : 'single';
                // Preserve an existing acquisition identity and completed assets.
                const previous = (message.snsMediaItems || []).find(old => old.id === item.id);
                return [{ ...item, ...(previous?.serverState === 'ready' ? previous : {}) }];
            }) : (message.snsMediaItems || []).filter(item => item.sourceId === source.id);
            message.snsMediaItems = (message.snsMediaItems || []).filter(item => item.sourceId !== source.id).concat(fresh);
            Object.assign(currentSource, { parseStatus: 'ready', parseError: '', imageUrls: metadata.images || [], mediaItemIds: fresh.map(item => item.id) });
            if (metadata.title) currentSource.title = metadata.title.slice(0, 240);
            if (metadata.images?.length) currentSource.coverUrl = metadata.images[0];
            delete currentSource.parseRetryCount; delete currentSource.parseRetryAfter;
            options.update(sessionId, message);
        },
        acquire: async (sessionId, messageId, mediaItemId) => {
            const result = await options.acquire(sessionId, messageId, mediaItemId);
            const generated = record(sessionId, result?.generatedMessageId);
            if (!generated) throw Error('SNS_POST_MEDIA_UNAVAILABLE');
            return generated;
        },
        image: createSnsPostImagePublisher({ assetDir: options.assetDir, record, registerAsset: options.registerAsset,
            fileInfo: options.fileInfo, publish, sender, authorize, readImage: options.readImage }),
        onError: options.onError
    });
}

module.exports = { sourceUrl, publicAddress, cookieHeader, configuredProxy, readPublicUrl, extractPostMetadata, readWebPost, readTwitterPost, readSnsPostContent, readPostImage, inspectSnsPost, createSnsPostImagePublisher,
    buildPostMarkdown, createSnsPostPublisher, createTunnelSnsPostPublisher };
