(function attachWebZipRuntime(global) {
    'use strict';
    const DB_NAME = 'TunnelWebZipRuntime';
    const DB_VERSION = 1;
    const STORE_NAME = 'runtimes';
    const DEFAULT_TTL = 2 * 60 * 60 * 1000;
    const RUNTIME_PROTOCOL = 2;
    let controllerReadyPromise = null;

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
    const runtimeType = (filePath, declaredType = '') => {
        const inferred = guessType(filePath);
        return inferred !== 'application/octet-stream' ? inferred : (declaredType || inferred);
    };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function repairExternalScriptTags(source) {
        const html = String(source || '');
        const lower = html.toLowerCase();
        const startPattern = /<script\b(?=[^>]*\bsrc\s*=)[^>]*>/gi;
        let match;
        let cursor = 0;
        let repaired = 0;
        let output = '';
        while ((match = startPattern.exec(html))) {
            output += html.slice(cursor, match.index) + match[0];
            const contentStart = startPattern.lastIndex;
            const closeIndex = lower.indexOf('</script', contentStart);
            const nextScriptIndex = lower.indexOf('<script', contentStart);
            if (closeIndex < 0 || (nextScriptIndex >= 0 && nextScriptIndex < closeIndex)) {
                output += '</script>';
                repaired += 1;
            }
            cursor = contentStart;
        }
        output += html.slice(cursor);
        return { html:output, repaired };
    }

    function prepareRuntimeFile(filePath, data) {
        const original = bytes(data).slice();
        if (!/\.html?$/i.test(filePath)) return { data:original, repaired:0 };
        const result = repairExternalScriptTags(new TextDecoder().decode(original));
        return result.repaired
            ? { data:new TextEncoder().encode(result.html), repaired:result.repaired }
            : { data:original, repaired:0 };
    }

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
            const channel = new MessageChannel();
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                channel.port1.onmessage = null;
                channel.port1.close?.();
                resolve(value);
            };
            const timer = setTimeout(() => finish(false), 1000);
            channel.port1.onmessage = event => {
                const capability = event.data || {};
                finish(Number(capability.webZipRuntime) >= RUNTIME_PROTOCOL && capability.externalScriptMime === true);
            };
            try {
                worker.postMessage({ type:'web-zip-runtime-ping' }, [channel.port2]);
            } catch (_) {
                finish(false);
            }
        });
    }

    function nudgeRegistration(registration) {
        try { registration.waiting?.postMessage({ type:'web-zip-runtime-activate' }); } catch (_) {}
        try { registration.active?.postMessage({ type:'web-zip-runtime-claim' }); } catch (_) {}
    }

    async function waitForCompatibleController(registration, timeout = 30000) {
        const deadline = Date.now() + timeout;
        let wake = null;
        const wakeNow = () => wake?.();
        navigator.serviceWorker.addEventListener('controllerchange', wakeNow);
        registration.addEventListener('updatefound', wakeNow);
        try {
            while (Date.now() < deadline) {
                nudgeRegistration(registration);
                if (await supportsRuntime(navigator.serviceWorker.controller)) return;
                await new Promise(resolve => {
                    const timer = setTimeout(() => {
                        wake = null;
                        resolve();
                    }, Math.min(250, Math.max(0, deadline - Date.now())));
                    wake = () => {
                        clearTimeout(timer);
                        wake = null;
                        resolve();
                    };
                });
            }
        } finally {
            navigator.serviceWorker.removeEventListener('controllerchange', wakeNow);
            registration.removeEventListener('updatefound', wakeNow);
        }
        throw new Error('网页 ZIP 运行服务启动超时，请稍后重试');
    }

    async function startController() {
        if (!('serviceWorker' in navigator)) throw new Error('当前浏览器不支持网页 ZIP 虚拟目录');
        const registration = await navigator.serviceWorker.register('/service-worker.js', { updateViaCache:'none' });
        nudgeRegistration(registration);
        await Promise.race([
            navigator.serviceWorker.ready,
            new Promise((_, reject) => setTimeout(() => reject(new Error('网页 ZIP 运行服务启动超时，请稍后重试')), 30000))
        ]);
        if (await supportsRuntime(navigator.serviceWorker.controller)) return;
        const controllerWait = waitForCompatibleController(registration);
        registration.update().catch(() => {}).finally(() => nudgeRegistration(registration));
        await controllerWait;
    }

    function ensureController() {
        if (!controllerReadyPromise) {
            controllerReadyPromise = startController().catch(error => {
                controllerReadyPromise = null;
                throw error;
            });
        }
        return controllerReadyPromise;
    }

    async function verifyRuntime(url) {
        let failure = null;
        for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
                const response = await fetch(url, { cache:'no-store' });
                const servedByRuntime = response.headers.get('X-Web-Zip-Runtime') === '1';
                try { await response.body?.cancel(); } catch (_) {}
                if (response.ok && servedByRuntime) return;
                failure = new Error(`网页 ZIP 运行目录校验失败（HTTP ${response.status}）`);
            } catch (error) {
                failure = error;
            }
            await sleep(120 * (attempt + 1));
        }
        throw failure || new Error('网页 ZIP 运行目录未能加载');
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
        let repairedScripts = 0;
        const files = (entries || []).filter(entry => !String(entry?.path || '').endsWith('/')).map(entry => {
            const path = normalizePath(entry.path);
            if (!path) throw new Error('网页 ZIP 中存在无效文件路径');
            const prepared = prepareRuntimeFile(path, entry.data);
            repairedScripts += prepared.repaired;
            return { path, type:runtimeType(path, entry.type), data:prepared.data };
        });
        if (!files.length) throw new Error('网页 ZIP 中没有可运行文件');
        const entry = options.entryPath
            ? files.find(file => file.path === normalizePath(options.entryPath))
            : files.find(file => /(^|\/)index\.html?$/i.test(file.path)) || files.find(file => /\.html?$/i.test(file.path));
        if (!entry) throw new Error('网页 ZIP 中没有 HTML 入口文件');
        const id = global.crypto?.randomUUID?.() || `runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const rootPath = entry.path.split('/').slice(0, -1).join('/');
        await transact('readwrite', store => store.put({ id, entryPath:entry.path, rootPath, files, createdAt:Date.now(), expiresAt:Date.now() + (Number(options.ttl) || DEFAULT_TTL) }));
        options.onStatus?.(repairedScripts ? `正在打开网页 ZIP（已兼容 ${repairedScripts} 个未闭合外链脚本标签）…` : '正在打开网页 ZIP…');
        const encodedPath = entry.path.split('/').map(encodeURIComponent).join('/');
        const url = `/web-zip-runtime/${encodeURIComponent(id)}/${encodedPath}?v=${Date.now()}`;
        try {
            await verifyRuntime(url);
        } catch (error) {
            await transact('readwrite', store => store.delete(id)).catch(() => {});
            throw error;
        }
        return { id, entryPath:entry.path, url, repairedScripts };
    }

    const unmount = id => id ? transact('readwrite', store => store.delete(id)) : Promise.resolve();
    global.WebZipRuntime = { mount, unmount, cleanup, _test:{ normalizePath, guessType, runtimeType, repairExternalScriptTags, supportsRuntime, RUNTIME_PROTOCOL } };
})(window);
