'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openDiskRepository } = require('./disk-repository');
const { loadKey } = require('./disk-data');
const { normalizeTelegramDrivePath } = require('./telegram-drive');

function createDiskStaticResources({ dataDir }) {
    const repository = openDiskRepository(dataDir);
    const keyFile = path.join(dataDir, 's3pub-signing.key');
    let key;
    try { key = loadKey(keyFile); }
    catch (error) { if (error.code !== 'EEXIST') throw error; key = fs.readFileSync(keyFile); }
    if (key.length !== 32) throw new Error('STATIC_SIGNING_KEY_INVALID');
    let state = repository.loadWithRevision('static_resources');
    const records = state.items;
    const reload = () => { state = repository.loadWithRevision('static_resources'); records.splice(0, records.length, ...state.items); };
    const save = () => {
        try { repository.replaceMany([{ table: 'static_resources', items: records, keyOf: item => item.id, base: state.revisions }]); reload(); }
        catch (error) { reload(); throw error; }
    };
    const sign = item => {
        const payload = Buffer.from(JSON.stringify({ v: 1, id: item.id, ownerId: item.ownerId, diskSpace: item.diskSpace, exp: item.expiresAt })).toString('base64url');
        return payload + '.' + crypto.createHmac('sha256', key).update(payload).digest('base64url');
    };
    const view = item => ({ id: item.id, token: sign(item), ownerId: item.ownerId, diskSpace: item.diskSpace,
        files: item.files, directories: item.directories, labels: item.labels || [], createdAt: item.createdAt, expiresAt: item.expiresAt, revokedAt: item.revokedAt });
    function expiration(input) {
        const preset = String(input.preset || '');
        const durations = { day: 86400, week: 7 * 86400, month: 30 * 86400 };
        if (preset === 'permanent') return 0;
        const seconds = durations[preset] || (preset === 'custom' ? Number(input.seconds) : 0);
        if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 10 * 365 * 86400) throw new Error('STATIC_EXPIRY_INVALID');
        return Date.now() + seconds * 1000;
    }
    return {
        create(scope, store, input = {}) {
            reload();
            const selections = input.items;
            if (!Array.isArray(selections) || !selections.length || selections.length > 100) throw new Error('STATIC_SELECTION_INVALID');
            const files = new Set(), directories = new Set(), labels = [];
            for (const selected of selections) {
                if (selected?.kind === 'directory') {
                    const folder = normalizeTelegramDrivePath(selected.path || '');
                    const target = folder && store.getDirectory(scope.userId, folder);
                    if (!target || ['blocked','deleted'].includes(target.reviewStatus)) throw new Error('DIRECTORY_NOT_FOUND');
                    directories.add(folder);
                    labels.push('/' + folder + '/');
                } else if (selected?.kind === 'file') {
                    const file = store.get(scope.userId, selected.id);
                    if (!file || ['blocked','deleted'].includes(file.reviewStatus)) throw new Error('FILE_NOT_FOUND');
                    files.add(file.id);
                    labels.push('/' + [file.folderPath, file.name].filter(Boolean).join('/'));
                } else throw new Error('STATIC_SELECTION_INVALID');
            }
            const item = { id: crypto.randomUUID(), ownerId: scope.userId, diskSpace: scope.diskSpace,
                files: [...files], directories: [...directories], labels, createdAt: Date.now(), expiresAt: expiration(input), revokedAt: 0 };
            records.push(item); save(); return view(item);
        },
        list(scope) { reload(); return records.filter(item => item.ownerId === scope.userId && item.diskSpace === scope.diskSpace).map(view); },
        revoke(scope, id) {
            reload();
            const item = records.find(entry => entry.id === id && entry.ownerId === scope.userId && entry.diskSpace === scope.diskSpace);
            if (!item) throw new Error('STATIC_NOT_FOUND');
            item.revokedAt ||= Date.now(); save(); return view(item);
        },
        resolve(token) {
            const [payload, mac, extra] = String(token || '').split('.');
            if (!payload || !mac || extra || payload.length > 1000) throw new Error('STATIC_NOT_FOUND');
            const expected = crypto.createHmac('sha256', key).update(payload).digest();
            let actual; try { actual = Buffer.from(mac, 'base64url'); } catch (_) { throw new Error('STATIC_NOT_FOUND'); }
            if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error('STATIC_NOT_FOUND');
            let claim; try { claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_) { throw new Error('STATIC_NOT_FOUND'); }
            // Observe revocation committed by another server process.
            reload();
            const item = records.find(entry => entry.id === claim.id);
            if (!item || claim.v !== 1 || item.ownerId !== claim.ownerId || item.diskSpace !== claim.diskSpace
                || item.expiresAt !== claim.exp || item.revokedAt || item.expiresAt && item.expiresAt <= Date.now()) throw new Error('STATIC_NOT_FOUND');
            return item;
        },
        file(item, store, requestedPath) {
            const safe = normalizeTelegramDrivePath(requestedPath || '');
            if (!safe || requestedPath !== safe) throw new Error('FILE_NOT_FOUND');
            const name = safe.split('/').at(-1), folderPath = safe.split('/').slice(0, -1).join('/');
            const file = store.list(item.ownerId, folderPath).files.find(entry => entry.name === name);
            if (!file || ['blocked','deleted'].includes(file.reviewStatus)
                || !item.files.includes(file.id) && !item.directories.some(dir => folderPath === dir || folderPath.startsWith(dir + '/')))
                throw new Error('FILE_NOT_FOUND');
            for (let folder = folderPath; folder; folder = folder.split('/').slice(0, -1).join('/')) {
                const parent = store.getDirectory(item.ownerId, folder);
                if (!parent || ['blocked','deleted'].includes(parent.reviewStatus)) throw new Error('FILE_NOT_FOUND');
            }
            return file;
        }
    };
}
module.exports = { createDiskStaticResources };
