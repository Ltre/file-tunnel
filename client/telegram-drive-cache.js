(function () {
    const DB = 'Drop2TunnelTelegramDrive';
    function open() { return new Promise((resolve, reject) => { const req = indexedDB.open(DB, 1); req.onupgradeneeded = () => req.result.createObjectStore('files', { keyPath: 'id' }); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
    async function put(id, file) { const db = await open(); try { return await new Promise((resolve, reject) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put({ id, ...file, cachedAt: Date.now() }); tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); }); } finally { db.close(); } }
    async function get(id) { const db = await open(); try { return await new Promise((resolve, reject) => { const req = db.transaction('files').objectStore('files').get(id); req.onsuccess = () => resolve(req.result || null); req.onerror = () => reject(req.error); }); } finally { db.close(); } }
    // Blob handles expose size without reading file bytes; use one transaction per view.
    async function status(items) {
        const db = await open();
        try { return await new Promise((resolve, reject) => {
            const result = {}, tx = db.transaction('files');
            for (const item of items) {
                const req = tx.objectStore('files').get(item.id);
                req.onsuccess = () => { result[item.id] = Boolean(req.result?.blob && req.result.blob.size === item.size); };
            }
            tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(tx.error);
        }); } finally { db.close(); }
    }
    window.TelegramDriveCache = { get, status, async put(id, file) {
        await put(id, file);
        window.dispatchEvent(new CustomEvent('disk-cache-changed', { detail: { id } }));
    } };
})();
