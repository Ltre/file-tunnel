'use strict';
const fs = require('fs');
const path = require('path');

// Only explicit diagnostic fields are logged: never request bodies, cookies or Bot URLs.
function networkDetails(error) {
    const clean = value => String(value || '').replace(/https?:\/\/\S+/gi, '[url]').replace(/(?:bot)?\d+:[\w-]+/g, '[credential]').slice(0, 300);
    return { name: clean(error?.name), code: clean(error?.code), message: clean(error?.message), causeCode: clean(error?.cause?.code), causeMessage: clean(error?.cause?.message), syscall: clean(error?.cause?.syscall || error?.syscall) };
}
function createDiskUploadLog(dataDir) {
    const filename = path.join(dataDir, 'disk-upload.log');
    return (event, fields = {}) => {
        const line = JSON.stringify({ time: new Date().toISOString(), event, ...fields });
        console.info('[disk-upload] ' + line);
        try {
            fs.mkdirSync(dataDir, { recursive: true });
            if (fs.existsSync(filename) && fs.statSync(filename).size >= 10 * 1024 * 1024) fs.renameSync(filename, filename + '.1');
            fs.appendFileSync(filename, line + '\n');
        } catch (error) { console.warn('[disk-upload] 无法写入诊断日志', error.code); }
    };
}
module.exports = { createDiskUploadLog, networkDetails };
