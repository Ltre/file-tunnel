'use strict';
const fs = require('fs');
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
module.exports = { readJson, writeJson, loadKey };
