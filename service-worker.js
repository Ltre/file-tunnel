const CACHE_NAME = 'instant-tunnel-v93-content-v8-themes-261028-followup';
const APP_SHELL = [
    '/',
    '/index.html',
    '/admin',
    '/admin.html',
    '/downloader',
    '/downloader.html',
    '/downloadList',
    '/downloadList.html',
    '/device.html',
    '/runtime-config.js',
    '/app.js',
    '/client/cache-store.js',
    '/client/index.css',
    '/client/themes-legacy.css',
    '/client/themes.css',
    '/client/theme-preference.js',
    '/client/disk-client.js',
    '/client/disk-operation-order.js',
    '/client/disk-pending-save.js',
    '/client/disk-saved-location.js',
    '/client/disk-saved-location.css',
    '/client/sns-download-cache.js',
    '/client/sns-post-i18n.js',
    '/client/sns-post-markdown.js',
    '/client/youtube-premium-cache.js',
    '/client/disk-error-messages.js',
    '/client/disk-trash-ui.js',
    '/client/disk-import-picker.js',
    '/client/disk-file-editor.js',
    '/client/disk-upload-names.js',
    '/client/disk-folder-upload.js',
    '/client/disk-directory-picker.js',
    '/client/disk-ui.js',
    '/client/disk-collaboration.js',
    '/client/disk-tunnel-adapter.js',
    '/client/disk.css',
    '/client/disk-directory-picker.css',
    '/client/telegram-drive-cache.js',
    '/client/cache-store-worker.js',
    '/client/disk-content-hash-worker.js',
    '/client/file-assets.js',
    '/client/folder-archive.js',
    '/client/web-zip-runtime.js',
    '/client/notification-center.js',
    '/client/notification-center.css',
    '/client/streaming-console.js',
    '/client/account-ui.js',
    '/client/account-ui.css',
    '/client/streaming-console.css',
    '/client/streaming-player.js',
    '/client/streaming-peers.js',
    '/client/icons/streaming.png',
    '/client/icons/quit-fullscreen.png',
    '/client/streaming-app-adapter.js',
    '/client/tunnel-markdown.js',
    '/client/streaming-i18n.js',
    '/client/web-workshop.js',
    '/client/web-workshop.css',
    '/client/vendor/web-markdown/marked-18.0.14.umd.js',
    '/client/vendor/web-markdown/purify-3.4.16.min.js',
    '/client/vendor/web-markdown/markdown-page.js',
    '/client/vendor/web-markdown/markdown-page.css',
    '/client/vendor/web-markdown/THIRD-PARTY-LICENSES.txt',
    '/web-workshop-guide.html',
    '/client/telegram-target-forward.js',
    '/client/telegram-target-forward.css',
    '/client/telegram-content.js',
    '/client/telegram-content.css',
    '/client/media.js',
    '/client/i18n-catalog.js',
    '/client/i18n.js',
    '/client/localization-runtime.js',
    '/client/light-transfer.js',
    '/client/qrcode-1.0.0.min.js',
    '/manifest.webmanifest',
    '/tunnel-icon.svg',
    '/prompts/resources/icons/fileview.png'
];
const PRECACHE_CORE = ['/index.html', '/manifest.webmanifest', '/tunnel-icon.svg'];

async function precacheAppShell() {
    const cache = await caches.open(CACHE_NAME);
    for (const resource of PRECACHE_CORE) {
        try {
            const response = await fetch(resource);
            if (response.ok && !response.redirected) await cache.put(resource, response);
        } catch (_) {}
    }
}

self.addEventListener('install', event => {
    event.waitUntil(precacheAppShell());
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', event => {
    if(event.data?.type==='streaming-peer-ping'){event.ports?.[0]?.postMessage({streamingPeer:1});return;}
    if (event.data?.type === 'web-zip-runtime-ping') {
        event.ports?.[0]?.postMessage({ webZipRuntime:2, externalScriptMime:true });
        return;
    }
    if (event.data?.type === 'web-zip-runtime-activate') {
        event.waitUntil(self.skipWaiting());
        return;
    }
    if (event.data?.type === 'web-zip-runtime-claim') {
        event.waitUntil(self.clients.claim());
        return;
    }
    if (event.data?.type !== 'tunnel-force-refresh') return;
    event.waitUntil(
        self.registration.update()
            .catch(() => undefined)
            .then(() => caches.keys())
            .then(keys => Promise.all(keys
                .filter(key => key.startsWith('instant-tunnel-'))
                .map(key => caches.delete(key))))
    );
});

self.addEventListener('notificationclick', event => {
    const targetUrl = event.notification.data?.url || '/';
    const absoluteUrl = new URL(targetUrl, self.location.origin).href;
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(clientList => {
                const sameOriginClient = clientList.find(client => new URL(client.url).origin === self.location.origin);
                if (sameOriginClient) {
                    if ('navigate' in sameOriginClient) {
                        return sameOriginClient.navigate(absoluteUrl).then(client => client?.focus?.());
                    }
                    return sameOriginClient.focus();
                }
                return clients.openWindow(absoluteUrl);
            })
    );
});

function isShareTargetPath(pathname) {
    return pathname === '/share' || pathname === '/share/';
}

function getWebZipRuntimeReferrer(request) {
    if (!request.referrer) return null;
    try {
        const referrer = new URL(request.referrer);
        if (referrer.origin !== self.location.origin || !referrer.pathname.startsWith('/web-zip-runtime/')) return null;
        const runtimeId = referrer.pathname.slice('/web-zip-runtime/'.length).split('/')[0];
        return runtimeId ? decodeURIComponent(runtimeId) : null;
    } catch (_) {
        return null;
    }
}

// Bound a warm PWA's shell wait without caching API/auth responses or runtime config.
async function loadAppNavigation(event) {
    const cachePromise = caches.open(CACHE_NAME);
    const network = fetch(event.request);
    event.waitUntil(network.then(async response => {
        if (response.ok && !response.redirected && response.headers.get('Content-Type')?.includes('text/html')) {
            const cache = await cachePromise;
            await cache.put('/index.html', response.clone());
        }
    }).catch(() => undefined));
    const cache = await cachePromise;
    const cached = await cache.match('/index.html');
    if (!cached) return network;
    let timer;
    try {
        return await Promise.race([
            network.then(response => response.status >= 500 ? cached : response).catch(() => cached),
            new Promise(resolve => { timer = setTimeout(() => resolve(cached), 1000); })
        ]);
    } finally { clearTimeout(timer); }
}

async function streamingPeerMedia(event,url){
    const ticket=url.pathname.split('/').pop(),fallback=()=>fetch(new Request(new URL('/api/streaming/media/'+ticket,self.location.origin),event.request));
    if(!/^[\w-]{20,80}$/.test(ticket))return new Response('',{status:404});
    const client=event.clientId&&await self.clients.get(event.clientId);if(!client)return fallback();
    const ask=(op,extra={})=>new Promise((resolve,reject)=>{
        const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();reject(Error('STREAM_PEER_TIMEOUT'));},30000);
        channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();event.data?.error?reject(Error(event.data.error)):resolve(event.data);};
        client.postMessage({type:'streaming-peer-read',op,ticket,...extra},[channel.port2]);
    });
    let meta;try{meta=await ask('open');}catch(_){return fallback();}
    const size=Number(meta.size);if(!Number.isSafeInteger(size)||size<=0)return fallback();
    const raw=event.request.headers.get('Range'),match=raw&&/^bytes=(\d*)-(\d*)$/.exec(raw);
    if(raw&&!match)return new Response('',{status:416,headers:{'Content-Range':'bytes */'+size}});
    let start=match?(match[1]?Number(match[1]):Math.max(0,size-Number(match[2]))):0;
    const end=match?(match[1]?(match[2]?Math.min(size-1,Number(match[2])):size-1):size-1):size-1;
    if(start>end||start>=size)return new Response('',{status:416,headers:{'Content-Range':'bytes */'+size}});
    const first=start;let cancelled=false;
    const body=new ReadableStream({async pull(controller){
        if(cancelled)return;
        if(start>end){controller.close();return;}
        const last=Math.min(end,start+(start===first?64*1024:1024*1024)-1);
        try{const result=await ask('read',{start,end:last});if(cancelled)return;if(!(result.body instanceof ArrayBuffer)||result.body.byteLength!==last-start+1)throw Error('STREAM_READ_INVALID');controller.enqueue(new Uint8Array(result.body));start=last+1;}
        catch(error){if(!cancelled)controller.error(error);}
    },cancel(){cancelled=true;}});
    const headers={'Content-Type':/^(video|audio|image)\//.test(meta.type||'')?meta.type:'text/plain; charset=utf-8','Content-Length':String(end-first+1),'Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"};
    if(match)headers['Content-Range']=`bytes ${first}-${end}/${size}`;
    return new Response(body,{status:match?206:200,headers});
}

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if(event.request.method==='GET'&&url.origin===self.location.origin&&url.pathname.startsWith('/streaming-peer-media/')){event.respondWith(streamingPeerMedia(event,url));return;}
    if (event.request.method === 'GET' && url.origin === self.location.origin && url.pathname.startsWith('/web-zip-runtime/')) {
        event.respondWith(handleWebZipRuntime(event.request, url));
        return;
    }
    const runtimeReferrerId = event.request.method === 'GET' && url.origin === self.location.origin
        ? getWebZipRuntimeReferrer(event.request)
        : null;
    if (runtimeReferrerId) {
        event.respondWith(redirectWebZipRuntimeRoot(url, runtimeReferrerId));
        return;
    }
    if (url.origin === self.location.origin && isShareTargetPath(url.pathname)) {
        if (event.request.method === 'POST') {
            event.respondWith(handleSharedFiles(event.request));
            return;
        }
        if (event.request.method === 'GET') {
            event.respondWith(Response.redirect(new URL('/?share=1&shareRoute=sw-get', self.location.origin), 303));
            return;
        }
    }
    if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/api/')) {
        event.respondWith(fetch(event.request));
        return;
    }

    const navigation = event.request.mode === 'navigate';
    if (navigation && ['/', '/index.html', '/disk', '/notification'].includes(url.pathname) && !url.searchParams.has('_reload') && !url.searchParams.has('tunnel_reload')) {
        event.respondWith(loadAppNavigation(event));
        return;
    }
    if (navigation || url.pathname === '/runtime-config.js' || url.pathname === '/service-worker.js' || url.pathname === '/client/web-zip-runtime.js') {
        event.respondWith(fetch(event.request).catch(() => caches.match(navigation ? '/index.html' : url.pathname)));
        return;
    }
    if (!APP_SHELL.includes(url.pathname)) return;
    event.respondWith(caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(url.pathname);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (response.ok && !response.redirected) await cache.put(url.pathname, response.clone());
        return response;
    }));
});

function openWebZipRuntimeDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('TunnelWebZipRuntime', 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('runtimes')) request.result.createObjectStore('runtimes', { keyPath:'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function readWebZipRuntime(runtimeId) {
    const db = await openWebZipRuntimeDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction('runtimes', 'readonly');
            const request = tx.objectStore('runtimes').get(runtimeId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } finally { db.close(); }
}

function getWebZipRuntimeContentType(filePath, declaredType = '') {
    const extension = String(filePath || '').split('.').pop()?.toLowerCase();
    const inferred = ({
        html:'text/html; charset=utf-8', htm:'text/html; charset=utf-8', css:'text/css; charset=utf-8',
        js:'text/javascript; charset=utf-8', mjs:'text/javascript; charset=utf-8', json:'application/json; charset=utf-8',
        txt:'text/plain; charset=utf-8', xml:'application/xml; charset=utf-8', svg:'image/svg+xml',
        png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', avif:'image/avif', ico:'image/x-icon',
        mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', mp4:'video/mp4', webm:'video/webm',
        woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf', otf:'font/otf', wasm:'application/wasm'
    })[extension];
    return inferred || declaredType || 'application/octet-stream';
}

async function redirectWebZipRuntimeRoot(sourceUrl, runtimeId) {
    const runtime = await readWebZipRuntime(runtimeId);
    if (!runtime || Number(runtime.expiresAt) <= Date.now()) return new Response('网页 ZIP 运行目录已过期', { status:410 });
    const requestedPath = sourceUrl.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part)).join('/');
    const filePath = requestedPath ? [runtime.rootPath, requestedPath].filter(Boolean).join('/') : runtime.entryPath || '';
    if (!filePath) return new Response('网页 ZIP 路径无效', { status:400 });
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const target = new URL(`/web-zip-runtime/${encodeURIComponent(runtimeId)}/${encodedPath}`, self.location.origin);
    target.search = sourceUrl.search;
    return Response.redirect(target.href, 307);
}

async function handleWebZipRuntime(request, url) {
    const parts = url.pathname.slice('/web-zip-runtime/'.length).split('/');
    const runtimeId = decodeURIComponent(parts.shift() || '');
    let filePath = parts.map(part => decodeURIComponent(part)).join('/');
    if (!runtimeId) return new Response('网页 ZIP 路径无效', { status:400 });
    const runtime = await readWebZipRuntime(runtimeId);
    if (!runtime || Number(runtime.expiresAt) <= Date.now()) return new Response('网页 ZIP 运行目录已过期', { status:410 });
    if (!filePath) filePath = runtime.entryPath || '';
    const file = (runtime.files || []).find(item => item.path === filePath);
    if (!file) return new Response('网页 ZIP 资源不存在', { status:404 });
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data || 0);
    const headers = {
        'Content-Type': getWebZipRuntimeContentType(filePath, file.type),
        'X-Web-Zip-Runtime': '1',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Accept-Ranges': 'bytes'
    };
    const range = String(request.headers.get('Range') || '');
    const match = range.match(/^bytes=(\d*)-(\d*)$/i);
    if (match && data.byteLength) {
        const suffixLength = !match[1] ? Number(match[2] || 0) : 0;
        let start = match[1] ? Number(match[1]) : data.byteLength - Math.min(data.byteLength, suffixLength);
        let end = match[2] && match[1] ? Number(match[2]) : data.byteLength - 1;
        if ((!match[1] && suffixLength <= 0) || start >= data.byteLength || start > end) {
            headers['Content-Range'] = `bytes */${data.byteLength}`;
            return new Response(null, { status:416, headers });
        }
        start = Math.max(0, start);
        end = Math.min(end, data.byteLength - 1);
        headers['Content-Range'] = `bytes ${start}-${end}/${data.byteLength}`;
        headers['Content-Length'] = String(end - start + 1);
        return new Response(data.slice(start, end + 1), { status:206, headers });
    }
    headers['Content-Length'] = String(data.byteLength);
    return new Response(data, { headers });
}

async function handleSharedFiles(request) {
    const redirectUrl = new URL('/?share=1', self.location.origin);
    try {
        const formData = await request.formData();
        const entries = [];
        for (const value of formData.values()) {
            if (!(value instanceof File) || value.size === 0) continue;
            entries.push({
                id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
                name: value.name || 'shared-file',
                type: value.type || 'application/octet-stream',
                size: value.size,
                lastModified: value.lastModified || Date.now(),
                createdAt: Date.now(),
                data: await value.arrayBuffer()
            });
        }
        if (entries.length) {
            await saveSharedFiles(entries);
        } else {
            redirectUrl.searchParams.set('shareEmpty', '1');
        }
    } catch (err) {
        console.error('PWA share target failed:', err);
        redirectUrl.searchParams.set('shareError', '1');
    }
    return Response.redirect(redirectUrl, 303);
}

function openTunnelDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('TunnelDB', 5);
        request.onupgradeneeded = event => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('sessions')) {
                const store = db.createObjectStore('sessions', { keyPath: 'sessionId' });
                store.createIndex('lastActive', 'lastActive', { unique: false });
            }
            if (!db.objectStoreNames.contains('messages')) {
                const store = db.createObjectStore('messages', { keyPath: 'id' });
                store.createIndex('sessionId', 'sessionId', { unique: false });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
            if (!db.objectStoreNames.contains('files')) {
                const store = db.createObjectStore('files', { keyPath: 'id' });
                store.createIndex('sessionId', 'sessionId', { unique: false });
            }
            if (!db.objectStoreNames.contains('editorContent')) {
                const store = db.createObjectStore('editorContent', { keyPath: 'id' });
                store.createIndex('sessionId', 'sessionId', { unique: false });
            }
            if (!db.objectStoreNames.contains('shareQueue')) {
                const store = db.createObjectStore('shareQueue', { keyPath: 'id' });
                store.createIndex('createdAt', 'createdAt', { unique: false });
            }
            if (!db.objectStoreNames.contains('contacts')) {
                const store = db.createObjectStore('contacts', { keyPath: 'deviceId' });
                store.createIndex('followedAt', 'followedAt', { unique: false });
                store.createIndex('lastSeenAt', 'lastSeenAt', { unique: false });
            }
            if (!db.objectStoreNames.contains('mounts')) {
                const store = db.createObjectStore('mounts', { keyPath: 'id' });
                store.createIndex('sessionId', 'sessionId', { unique: false });
                store.createIndex('kind', 'kind', { unique: false });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveSharedFiles(entries) {
    const db = await openTunnelDb();
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction(['shareQueue'], 'readwrite');
            const store = transaction.objectStore('shareQueue');
            entries.forEach(entry => store.put(entry));
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('IndexedDB shareQueue write aborted'));
        });
    } finally {
        db.close();
    }
}
