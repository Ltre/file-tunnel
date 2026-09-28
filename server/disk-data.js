'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('DISK_INDEX_UNREADABLE', { cause: error }); }
}
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temp, file);
}
// Upload manifests are rewritten while antivirus/indexers may briefly hold the
// destination on Windows. Keep the old manifest intact and retry its atomic
// replacement without blocking unrelated requests.
async function writeJsonAsync(file, value, { retries = 5, retryDelayMs = 25 } = {}) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
        await fsp.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
        for (let attempt = 0; ; attempt++) {
            try { await fsp.rename(temp, file); return; }
            catch (error) {
                if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= retries) throw error;
                await new Promise(resolve => setTimeout(resolve, Math.min(250, retryDelayMs * 2 ** attempt)));
            }
        }
    } finally {
        try { await fsp.unlink(temp); }
        catch (error) { if (error.code !== 'ENOENT') console.warn('[disk-upload] manifest.temp-cleanup-failed', { code: error.code }); }
    }
}
function loadKey(file) {
    try { return fs.readFileSync(file); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const key = crypto.randomBytes(32);
        fs.writeFileSync(file, key, { flag: 'wx', mode: 0o600 });
        return key;
    }
}
module.exports = { readJson, writeJson, writeJsonAsync, loadKey };
