const CACHE_NAME = 'instant-tunnel-v55';
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
    '/client/disk-client.js',
    '/client/disk-ui.js',
    '/client/disk-tunnel-adapter.js',
    '/client/disk.css',
    '/client/telegram-drive-cache.js',
    '/client/cache-store-worker.js',
    '/client/file-assets.js',
    '/client/folder-archive.js',
    '/client/web-zip-runtime.js',
    '/client/notification-center.js',
    '/client/notification-center.css',
    '/client/web-workshop.js',
    '/client/web-workshop.css',
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
    '/tunnel-icon.svg'
];

async function precacheAppShell() {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(APP_SHELL.map(async resource => {
        const response = await fetch(new Request(resource, { cache:'reload' }));
        if (!response.ok || response.redirected) return;
        await cache.put(resource, response);
    }));
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
    if (event.data?.type === 'web-zip-runtime-ping') {
        event.ports?.[0]?.postMessage({ webZipRuntime:1 });
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

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
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

    const shouldReload = APP_SHELL.includes(url.pathname) || url.pathname === '/service-worker.js';
    const request = shouldReload ? new Request(event.request, { cache: 'reload' }) : event.request;
    event.respondWith(
        fetch(request)
            .then(response => {
                const copy = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                return response;
            })
            .catch(() => caches.match(event.request).then(response => response || caches.match('/index.html')))
    );
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
        'Content-Type': file.type || 'application/octet-stream',
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
