(function attachWebZipRuntime(global) {
    'use strict';
    const DB_NAME = 'TunnelWebZipRuntime';
    const DB_VERSION = 1;
    const STORE_NAME = 'runtimes';
    const DEFAULT_TTL = 2 * 60 * 60 * 1000;

    const bytes = data => data instanceof Uint8Array ? data : new Uint8Array(data || 0);
    const normalizePath = value => String(value || '').replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..').join('/');
    const guessType = filePath => ({
        html:'text/html; charset=utf-8', htm:'text/html; charset=utf-8', css:'text/css; charset=utf-8',
        js:'text/javascript; charset=utf-8', mjs:'text/javascript; charset=utf-8', json:'application/json; charset=utf-8',
        txt:'text/plain; charset=utf-8', xml:'application/xml; charset=utf-8', svg:'image/svg+xml',
        png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', avif:'image/avif', ico:'image/x-icon',
        mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', mp4:'video/mp4', webm:'video/webm',
        woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf', otf:'font/otf', wasm:'application/wasm'
    })[String(filePath || '').split('.').pop()?.toLowerCase()] || 'application/octet-stream';

    function openDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath:'id' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function transact(mode, operation) {
        const db = await openDb();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, mode);
                const request = operation(tx.objectStore(STORE_NAME));
                tx.oncomplete = () => resolve(request?.result);
                tx.onerror = tx.onabort = () => reject(tx.error || request?.error);
            });
        } finally { db.close(); }
    }

    function supportsRuntime(worker) {
        if (!worker) return Promise.resolve(false);
        return new Promise(resolve => {
            const channel = new MessageChannel(), timer = setTimeout(() => resolve(false), 600);
            channel.port1.onmessage = event => { clearTimeout(timer); resolve(event.data?.webZipRuntime === 1); };
            worker.postMessage({ type:'web-zip-runtime-ping' }, [channel.port2]);
        });
    }

    async function ensureController() {
        if (!('serviceWorker' in navigator)) throw new Error('当前浏览器不支持网页 ZIP 虚拟目录');
        const registration = await navigator.serviceWorker.register('/service-worker.js', { updateViaCache:'none' });
        await Promise.race([
            navigator.serviceWorker.ready,
            new Promise((_, reject) => setTimeout(() => reject(new Error('网页 ZIP 运行服务启动超时，请刷新页面后重试')), 12000))
        ]);
        if (await supportsRuntime(navigator.serviceWorker.controller)) return;
        await registration.update().catch(() => {});
        await new Promise((resolve, reject) => {
            const finish = async () => {
                if (!await supportsRuntime(navigator.serviceWorker.controller)) return;
                clearTimeout(timer);navigator.serviceWorker.removeEventListener('controllerchange',finish);resolve();
            };
            const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange',finish);reject(new Error('网页 ZIP 运行服务尚未更新，请刷新后重试')); }, 10000);
            navigator.serviceWorker.addEventListener('controllerchange',finish);
            finish();
        });
    }

    async function cleanup() {
        const records = await transact('readonly', store => store.getAll());
        const expired = (records || []).filter(record => Number(record.expiresAt) <= Date.now());
        for (const record of expired) await transact('readwrite', store => store.delete(record.id));
    }

    async function mount(entries, options = {}) {
        options.onStatus?.('正在启动网页 ZIP 运行服务…');
        await ensureController();
        options.onStatus?.('正在准备网页 ZIP 虚拟目录…');
        await cleanup().catch(() => {});
        const files = (entries || []).filter(entry => !String(entry?.path || '').endsWith('/')).map(entry => {
            const path = normalizePath(entry.path);
            if (!path) throw new Error('网页 ZIP 中存在无效文件路径');
            return { path, type:entry.type || guessType(path), data:bytes(entry.data).slice() };
        });
        if (!files.length) throw new Error('网页 ZIP 中没有可运行文件');
        const entry = options.entryPath
            ? files.find(file => file.path === normalizePath(options.entryPath))
            : files.find(file => /(^|\/)index\.html?$/i.test(file.path)) || files.find(file => /\.html?$/i.test(file.path));
        if (!entry) throw new Error('网页 ZIP 中没有 HTML 入口文件');
        const id = global.crypto?.randomUUID?.() || `runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const rootPath = entry.path.split('/').slice(0, -1).join('/');
        await transact('readwrite', store => store.put({ id, entryPath:entry.path, rootPath, files, createdAt:Date.now(), expiresAt:Date.now() + (Number(options.ttl) || DEFAULT_TTL) }));
        options.onStatus?.('正在打开网页 ZIP…');
        const encodedPath = entry.path.split('/').map(encodeURIComponent).join('/');
        return { id, entryPath:entry.path, url:`/web-zip-runtime/${encodeURIComponent(id)}/${encodedPath}?v=${Date.now()}` };
    }

    const unmount = id => id ? transact('readwrite', store => store.delete(id)) : Promise.resolve();
    global.WebZipRuntime = { mount, unmount, cleanup, _test:{ normalizePath, guessType } };
})(window);
