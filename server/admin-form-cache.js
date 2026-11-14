'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), { randomUUID } = require('node:crypto');
const KINDS = new Set(['sns-dl', 'youtube-premium-dl']);
const FIELDS = new Set(['mode', 'url', 'asMusic', 'cacheFiles', 'downloadSections', 'remark', 'manualFormat', 'useManualFormat']);
const fail = (message, status) => Object.assign(new Error(message), { status });
function createAdminFormStore(dataDir) {
    const queues = new Map();
    const directory = kind => { if (!KINDS.has(kind)) throw fail('admin-form-kind-invalid', 400); return path.join(dataDir, 'admin-forms', kind); };
    async function serial(kind, action) {
        directory(kind);
        const previous = queues.get(kind) || Promise.resolve(), next = previous.catch(() => {}).then(action);
        queues.set(kind, next);
        try { return await next; } finally { if (queues.get(kind) === next) queues.delete(kind); }
    }
    async function read(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
    async function write(file, value) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = file + '.' + randomUUID() + '.tmp';
        try { await fs.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx' }); await fs.rename(temporary, file); }
        finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    async function list(kind) {
        const folder = directory(kind);
        const files = await fs.readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        const forms = [];
        for (const file of files.filter(name => /^[1-9]\d*\.json$/.test(name))) { const form = await read(path.join(folder, file)); if (form) forms.push(form); }
        return forms.sort((a, b) => a.id - b.id);
    }
    function fileFor(kind, id) {
        if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) throw fail('admin-form-id-invalid', 400);
        return path.join(directory(kind), id + '.json');
    }
    function payload(value) {
        if (!value || typeof value !== 'object' || !/^[\w-]{16,100}$/.test(value.clientKey || '') || !value.form || Array.isArray(value.form)) throw fail('admin-form-invalid', 400);
        const form = Object.fromEntries(Object.entries(value.form).filter(([key]) => FIELDS.has(key)));
        if (Object.values(form).some(item => typeof item !== 'string' && typeof item !== 'boolean')) throw fail('admin-form-invalid', 400);
        if (!['url', 'remark', 'downloadSections', 'manualFormat'].some(key => String(form[key] || '').trim())) throw fail('admin-form-empty', 400);
        const analysis = value.analysis ?? null;
        if (analysis && (typeof analysis !== 'object' || !Array.isArray(analysis.formats))) throw fail('admin-form-formats-invalid', 400);
        const result = { clientKey: value.clientKey, form, analysis, ids: Array.isArray(value.ids) ? value.ids.map(String) : null };
        if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw fail('admin-form-too-large', 413);
        return result;
    }
    return {
        list: kind => serial(kind, () => list(kind)),
        get: (kind, id) => serial(kind, async () => { const form = await read(fileFor(kind, id)); if (!form) throw fail('admin-form-not-found', 404); return form; }),
        save: (kind, id, value) => serial(kind, async () => {
            const data = payload(value), folder = directory(kind);
            let previous;
            if (id != null) {
                previous = await read(fileFor(kind, id));
                if (!previous) throw fail('admin-form-not-found', 404);
                if (previous.clientKey !== data.clientKey || previous.revision !== value.revision) throw fail('admin-form-version-conflict', 409);
            } else {
                const forms = await list(kind);
                previous = forms.find(form => form.clientKey === data.clientKey);
                // A repeated initial save has the same stable identity. Return
                // the accepted snapshot; never overwrite it with a late retry.
                if (previous) return previous;
                const occupied = new Set(forms.map(form => form.id));
                const localIds = Array.isArray(value.localIds) ? value.localIds : [];
                if (localIds.length > 10000 || localIds.some(item => !Number.isSafeInteger(item) || item < 1)) throw fail('admin-form-id-invalid', 400);
                const preferred = value.preferredId;
                if (preferred != null && (!Number.isSafeInteger(preferred) || preferred < 1)) throw fail('admin-form-id-invalid', 400);
                id = preferred && !occupied.has(preferred) ? preferred : 1;
                const unavailable = new Set([...occupied, ...localIds]);
                while (unavailable.has(id)) id++;
                if (!Number.isSafeInteger(id)) throw fail('admin-form-id-exhausted', 507);
            }
            const record = { ...data, id: Number(id), revision: randomUUID(), updatedAt: Date.now() };
            await write(fileFor(kind, id), record);
            return record;
        }),
        remove: (kind, id, revision) => serial(kind, async () => {
            const file = fileFor(kind, id), previous = await read(file);
            if (!previous) return;
            if (previous.revision !== revision) throw fail('admin-form-version-conflict', 409);
            await fs.unlink(file);
        })
    };
}
function createAdminFormRouter({ dataDir }) {
    const router = require('express').Router(), store = createAdminFormStore(dataDir);
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    const route = action => async (req, res) => {
        try { await action(req, res); }
        catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : 'admin-form-storage-failed' }); }
    };
    router.get('/:kind', route(async (req, res) => res.json({ forms: await store.list(req.params.kind) })));
    router.get('/:kind/:id', route(async (req, res) => res.json({ form: await store.get(req.params.kind, req.params.id) })));
    router.post('/:kind', route(async (req, res) => res.json({ form: await store.save(req.params.kind, null, req.body) })));
    router.put('/:kind/:id', route(async (req, res) => res.json({ form: await store.save(req.params.kind, req.params.id, req.body) })));
    router.delete('/:kind/:id', route(async (req, res) => { await store.remove(req.params.kind, req.params.id, req.body?.revision); res.json({ ok: true }); }));
    return router;
}
module.exports = { createAdminFormStore, createAdminFormRouter };
