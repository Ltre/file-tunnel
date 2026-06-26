const CACHE_NAME = 'instant-tunnel-v20';
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
    '/client/file-assets.js',
    '/client/folder-archive.js',
    '/client/media.js',
    '/client/qrcode-1.0.0.min.js',
    '/manifest.webmanifest',
    '/tunnel-icon.svg'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
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

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method === 'POST' && url.pathname === '/share/') {
        event.respondWith(handleSharedFiles(event.request));
        return;
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

async function handleSharedFiles(request) {
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
    if (entries.length) await saveSharedFiles(entries);
    return Response.redirect(new URL('/?share=1', self.location.origin), 303);
}

function openTunnelDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('TunnelDB', 4);
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
        });
    } finally {
        db.close();
    }
}
