'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function resolveDataUsageDirectory(rootDirectory, requestedPath = '') {
    const root = path.resolve(rootDirectory);
    const normalized = String(requestedPath || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');
    if (normalized.split('/').some(part => part === '..' || part.includes('\0'))) throw Object.assign(new Error('INVALID_DATA_USAGE_PATH'), { status: 400 });
    const target = path.resolve(root, normalized);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Object.assign(new Error('INVALID_DATA_USAGE_PATH'), { status: 400 });
    return { root, target, relative: relative.split(path.sep).join('/') };
}

async function logicalSize(target) {
    const stat = await fs.promises.lstat(target);
    if (!stat.isDirectory()) return stat.size;
    const children = await fs.promises.readdir(target);
    let size = stat.size;
    for (const name of children) size += await logicalSize(path.join(target, name));
    return size;
}

async function occupiedSize(target) {
    if (process.platform !== 'win32') {
        try {
            const { stdout } = await execFileAsync('du', ['-sk', '--', target], { windowsHide: true, maxBuffer: 1024 * 1024 });
            const kibibytes = Number(String(stdout).match(/^\s*(\d+)/)?.[1]);
            if (Number.isFinite(kibibytes)) return kibibytes * 1024;
        } catch (_) {}
    }
    return logicalSize(target);
}

async function mapLimited(values, limit, mapper) {
    const output = new Array(values.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
        while (cursor < values.length) {
            const index = cursor++;
            output[index] = await mapper(values[index], index);
        }
    }));
    return output;
}

async function listDataUsage(rootDirectory, requestedPath = '') {
    const resolved = resolveDataUsageDirectory(rootDirectory, requestedPath);
    const stat = await fs.promises.stat(resolved.target).catch(error => {
        if (error.code === 'ENOENT') throw Object.assign(new Error('DATA_USAGE_PATH_NOT_FOUND'), { status: 404 });
        throw error;
    });
    if (!stat.isDirectory()) throw Object.assign(new Error('DATA_USAGE_PATH_NOT_DIRECTORY'), { status: 400 });
    const dirents = await fs.promises.readdir(resolved.target, { withFileTypes: true });
    const entries = await mapLimited(dirents, 4, async dirent => ({
        name: dirent.name,
        path: [resolved.relative, dirent.name].filter(Boolean).join('/'),
        kind: dirent.isDirectory() ? 'directory' : 'file',
        size: await occupiedSize(path.join(resolved.target, dirent.name))
    }));
    entries.sort((left, right) => right.size - left.size || left.name.localeCompare(right.name, 'zh-CN'));
    return { path: resolved.relative, entries, totalSize: entries.reduce((sum, entry) => sum + entry.size, 0), generatedAt: Date.now() };
}

module.exports = { listDataUsage, resolveDataUsageDirectory };
