(function () {
    const DB = 'Drop2TunnelTelegramDrive';
    function open() { return new Promise((resolve, reject) => { const req = indexedDB.open(DB, 1); req.onupgradeneeded = () => req.result.createObjectStore('files', { keyPath: 'id' }); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
    async function put(id, file) { const db = await open(); return new Promise((resolve, reject) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put({ id, ...file, cachedAt: Date.now() }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); }
    async function get(id) { const db = await open(); return new Promise((resolve, reject) => { const req = db.transaction('files').objectStore('files').get(id); req.onsuccess = () => resolve(req.result || null); req.onerror = () => reject(req.error); }); }
    window.TelegramDriveCache = { put, get };
})();
