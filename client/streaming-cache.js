(function (global) {
    'use strict';
    // IndexedDB byte snapshots, independent of the suspended OPFS driver.
    // Source references protect imports; viewer blocks never grant playback access.
    const BLOCK = 1024 * 1024;
    let opening;
    function database() {
        if (!opening) opening = new Promise((resolve, reject) => {
            const request = indexedDB.open('drop2tunnel-streaming-cache', 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore('resources', { keyPath: 'key' });
                request.result.createObjectStore('blocks', { keyPath: ['key', 'start'] }).createIndex('key', 'key');
            };
            request.onerror = () => { opening = null; reject(request.error); };
            request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opening = null; }; resolve(db); };
        });
        return opening;
    }
    async function transaction(stores, mode, run) {
        const db = await database();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(stores, mode); let result;
            tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(tx.error || Error('STREAM_CACHE_WRITE_FAILED'));
            try { run(tx, value => { result = value; }); } catch (cause) { tx.abort(); reject(cause); }
        });
    }
    const get = (store, key) => transaction([store], 'readonly', (tx, done) => { tx.objectStore(store).get(key).onsuccess = event => done(event.target.result); });
    const put = (store, value) => transaction([store], 'readwrite', tx => tx.objectStore(store).put(value));
    const sourceKey = (device, file) => JSON.stringify(['source', device, file]);
    const viewerKey = (actor, identity) => JSON.stringify(['viewer', actor, identity]);
    async function remove(key, role) {
        await transaction(['resources', 'blocks'], 'readwrite', tx => {
            const resources = tx.objectStore('resources');
            resources.get(key).onsuccess = event => {
                if (!event.target.result || event.target.result.role !== role) return;
                resources.delete(key);
                tx.objectStore('blocks').index('key').openCursor(IDBKeyRange.only(event.target.result.blockKey || key)).onsuccess = event => { const cursor = event.target.result; if (cursor) { cursor.delete(); cursor.continue(); } };
            };
        });
    }
    async function source(device, fileId, file, stationId) {
        const key = sourceKey(device, fileId);
        // Reselection keeps the original readable snapshot until the new one commits.
        const generation = String(Date.now()) + ':' + Math.random().toString(36).slice(2), chunkKey = key + ':' + generation;
        const staging={ key:chunkKey, blockKey:chunkKey, role:'staging', createdAt:Date.now(), name:file.name, device, stationId, cachedBytes:0 };
        await put('resources', staging);
        try {
            for (let start = 0; start < file.size; start += BLOCK) {
                const bytes = await file.slice(start, start + BLOCK).arrayBuffer();
                await transaction(['resources','blocks'],'readwrite',tx=>{
                    tx.objectStore('blocks').put({key:chunkKey,start,body:new Blob([bytes],{type:file.type})});
                    tx.objectStore('resources').put({...staging,cachedBytes:start+bytes.byteLength});
                });
            }
            let replaced;
            await transaction(['resources'], 'readwrite', tx => {
                const store=tx.objectStore('resources');
                store.get(key).onsuccess=event=>{
                    const old=event.target.result;
                    replaced=old?.blockKey;
                    if(replaced)store.put({key:replaced,blockKey:replaced,role:'staging',createdAt:0,name:old.name,cachedBytes:old.size});
                    store.put({ key, role:'source', device, fileId, stationIds:[...new Set([...(event.target.result?.stationIds || []),stationId])],
                        name:file.name,type:file.type,size:file.size,generation,blockKey:chunkKey,ready:true });store.delete(chunkKey);
                };
            });
            if (replaced) await remove(replaced,'staging').catch(()=>{});
        } catch (cause) { await remove(chunkKey,'staging').catch(() => {}); throw cause; }
    }
    async function deleteBlocks(key) {
        await transaction(['blocks'], 'readwrite', tx => {
            tx.objectStore('blocks').index('key').openCursor(IDBKeyRange.only(key)).onsuccess = event => { const c = event.target.result; if (c) { c.delete(); c.continue(); } };
        });
    }
    async function readBody(entry, start = 0, end = entry.size - 1) {
        if (start < 0 || end >= entry.size || end < start) return null;
        const parts = [];
        for (let offset = Math.floor(start / BLOCK) * BLOCK; offset <= end; offset += BLOCK) {
            const block = await get('blocks', [entry.blockKey || entry.key, offset]);
            if (!block || block.body.size !== Math.min(BLOCK, entry.size - offset)) return null;
            parts.push(block.body.slice(Math.max(0, start - offset), Math.min(block.body.size, end - offset + 1)));
        }
        return new Blob(parts, { type: entry.type });
    }
    async function local(device, descriptor, range) {
        const entry = await get('resources', sourceKey(device, descriptor.fileId));
        if (!entry?.ready || entry.name !== descriptor.name || entry.size !== descriptor.size) return null;
        return readBody(entry, range?.start ?? 0, range?.end ?? entry.size - 1);
    }
    async function list() {
        return transaction(['resources'], 'readonly', (tx, done) => { tx.objectStore('resources').getAll().onsuccess = event => done(event.target.result); });
    }
    async function updateStation(device, stationId, fileIds) {
        const keep = new Set(fileIds);
        for (const entry of await list()) {
            if (entry.role !== 'source' || entry.device !== device) continue;
            await transaction(['resources', 'blocks'], 'readwrite', tx => {
                const resources = tx.objectStore('resources');
                resources.get(entry.key).onsuccess = event => {
                    const current = event.target.result; if (!current || current.role !== 'source') return;
                    const refs = new Set(current.stationIds); keep.has(current.fileId) ? refs.add(stationId) : refs.delete(stationId);
                    if (refs.size) resources.put({ ...current, stationIds: [...refs] });
                    else {
                        resources.delete(current.key);
                        tx.objectStore('blocks').index('key').openCursor(IDBKeyRange.only(current.blockKey)).onsuccess = event => { const c = event.target.result; if (c) { c.delete(); c.continue(); } };
                    }
                };
            });
        }
    }
    async function retainViewer(actor, meta, relation, start, bytes) {
        if (!meta.key || !Number.isSafeInteger(start) || start < 0 || !bytes.byteLength || bytes.byteLength > BLOCK || start + bytes.byteLength > meta.size) return;
        const key = viewerKey(actor, meta.key);
        await transaction(['resources', 'blocks'], 'readwrite', tx => {
            const store=tx.objectStore('resources');store.get(key).onsuccess=event=>{
                const ranges=new Map(event.target.result?.ranges || []);
                if ((ranges.get(start) || 0) >= bytes.byteLength) return;
                ranges.set(start,bytes.byteLength);
                let covered=0,last=0;for(const [offset,length] of [...ranges].sort((a,b)=>a[0]-b[0])){covered+=Math.max(0,offset+length-Math.max(last,offset));last=Math.max(last,offset+length);}
                store.put({ key, role:'viewer', name:relation.name, stationId:relation.stationId, itemId:relation.itemId, ranges:[...ranges],
                    sourceKind:relation.sourceKind, identity:meta.key, size:meta.size, type:meta.type, cachedBytes:covered });
                tx.objectStore('blocks').put({ key, start, body:new Blob([bytes],{type:meta.type}) });
            };
        });
    }
    async function viewer(actor, meta, start, end) {
        const entry = await get('resources', viewerKey(actor, meta.key));
        if(!entry || entry.size!==meta.size || start<0 || end>=entry.size || end<start)return null;
        const parts=[];let cursor=start;
        for(const [offset,length] of (entry.ranges || []).sort((a,b)=>a[0]-b[0])){
            if(offset>cursor)break;if(offset+length<=cursor)continue;
            const block=await get('blocks',[entry.key,offset]);if(!block || block.body.size!==length)return null;
            const last=Math.min(end+1,offset+length);parts.push(block.body.slice(cursor-offset,last-offset));cursor=last;
            if(cursor>end)return new Blob(parts,{type:entry.type});
        }
        return null;
    }
    global.StreamingCache = { BLOCK, source, local, updateStation, retainViewer, viewer,
        async garbage() { return (await list()).filter(entry => entry.role === 'viewer' || entry.role === 'staging' && entry.createdAt < Date.now()-86400000); },
        async clearViewer(keys) { for (const key of keys) { await remove(key,'viewer');const entry=await get('resources',key);if(entry?.role==='staging'&&entry.createdAt<Date.now()-86400000)await remove(key,'staging'); } }
    };
})(window);
