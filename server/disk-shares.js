'use strict';
const crypto = require('crypto');
const path = require('path');
const { readJson, writeJson } = require('./disk-data');
const { normalizeTelegramDrivePath } = require('./telegram-drive');

// Capability links expose a snapshot of selected IDs, never a user-supplied owner/path.
function createDiskShares({ dataDir, now = Date.now }) {
    const filename = path.join(dataDir, 'disk-shares.json');
    const records = readJson(filename, []);
    const save = () => writeJson(filename, records);
    const owns = (item, scope) => item.ownerId === scope.userId && item.diskSpace === scope.diskSpace;
    const view = item => ({ id: item.id, url: '/disk-share/' + item.token, title: item.title, createdAt: item.createdAt, stoppedAt: item.stoppedAt, fileCount: item.files.length, directoryCount: item.directories.length });
    return {
        create(scope, store, selections) {
            if (!Array.isArray(selections) || !selections.length || selections.length > 100) throw new Error('SHARE_SELECTION_INVALID');
            const files = new Map(), directories = new Set(), names = [];
            for (const selection of selections) {
                if (selection.kind === 'directory') {
                    const base = normalizeTelegramDrivePath(selection.path);
                    if (!base) throw new Error('SHARE_ROOT_FORBIDDEN');
                    const tree = store.getDirectoryTree(scope.userId, base);
                    if (!tree) throw new Error('DIRECTORY_NOT_FOUND');
                    if (tree.files.some(file => file.reviewStatus === 'blocked' || file.reviewStatus === 'deleted')) throw new Error('SHARE_REVIEW_RESTRICTED');
                    names.push(tree.name);
                    // Preserve selected directory names and relative subdirectories.
                    const prefix = base.split('/').slice(0, -1).join('/');
                    const relative = value => prefix ? value.slice(prefix.length + 1) : value;
                    for (const folder of tree.directories) directories.add(relative(folder.path));
                    for (const file of tree.files) files.set(file.id, { id: file.id, name: file.name, folderPath: relative(file.folderPath) });
                } else {
                    const file = store.get(scope.userId, selection.id);
                    if (!file) throw new Error('FILE_NOT_FOUND');
                    if (file.reviewStatus === 'blocked' || file.reviewStatus === 'deleted') throw new Error('SHARE_REVIEW_RESTRICTED');
                    names.push(file.name); files.set(file.id, { id: file.id, name: file.name, folderPath: '' });
                }
            }
            if (files.size > 10000 || directories.size > 10000) throw new Error('SHARE_TOO_LARGE');
            const item = { id: crypto.randomUUID(), token: crypto.randomBytes(32).toString('base64url'), ownerId: scope.userId, diskSpace: scope.diskSpace, createdAt: now(), stoppedAt: 0, title: names.length === 1 ? names[0] : names[0] + ' 等 ' + names.length + ' 项', files: [...files.values()], directories: [...directories] };
            records.push(item); save(); return view(item);
        },
        list(scope) { return records.filter(item => owns(item, scope)).slice().reverse().map(view); },
        stop(scope, id) {
            const item = records.find(item => item.id === id && owns(item, scope));
            if (!item) throw new Error('SHARE_NOT_FOUND');
            item.stoppedAt ||= now(); save(); return view(item);
        },
        resolve(token) {
            if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('SHARE_NOT_FOUND');
            const item = records.find(item => item.token === token && !item.stoppedAt);
            if (!item) throw new Error('SHARE_NOT_FOUND');
            return item;
        },
        contents(item, store, folderPath = '') {
            const safe = normalizeTelegramDrivePath(folderPath);
            if (safe && !item.directories.includes(safe)) throw new Error('DIRECTORY_NOT_FOUND');
            const parent = value => value.split('/').slice(0, -1).join('/');
            const folders = item.directories.filter(value => parent(value) === safe).map(value => ({ kind: 'directory', name: value.split('/').pop(), path: value }));
            const files = item.files.filter(file => file.folderPath === safe).flatMap(entry => {
                const file = store.get(item.ownerId, entry.id);
                return file && !['blocked', 'deleted'].includes(file.reviewStatus) ? [{ kind: 'file', id: entry.id, name: entry.name, type: file.type, size: file.size }] : [];
            });
            return { title: item.title, createdAt: item.createdAt, path: safe, folders, files };
        },
        file(item, store, id) {
            if (!item.files.some(file => file.id === id)) throw new Error('FILE_NOT_FOUND');
            const file = store.get(item.ownerId, id);
            if (!file || ['blocked', 'deleted'].includes(file.reviewStatus)) throw new Error('FILE_NOT_FOUND');
            return file;
        }
    };
}
module.exports = { createDiskShares };
