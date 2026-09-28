'use strict';
const path = require('node:path');
const { createS3Credentials } = require('../server/s3/credentials');
const { openDiskRepository } = require('../server/disk-repository');

function main(argv = process.argv.slice(2)) {
    let dataDir = path.resolve('.tunnel-data'), mode = '', userId = '', accessKeyId = '', backendId = '';
    const buckets = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--data-dir') dataDir = path.resolve(argv[++i] || '');
        else if (arg === '--create' || arg === '--list') mode = arg.slice(2);
        else if (arg === '--disable') { mode = 'disable'; accessKeyId = argv[++i]; }
        else if (arg === '--user-id') userId = argv[++i];
        else if (arg === '--bucket') buckets.push(argv[++i]);
        else if (arg === '--backend-id') backendId = argv[++i];
        else throw new Error(`未知参数：${arg}`);
    }
    const credentials = createS3Credentials(dataDir);
    if (mode === 'list') return credentials.list();
    if (mode === 'disable') { credentials.disable(accessKeyId); return { disabled: accessKeyId }; }
    if (mode !== 'create') throw new Error('请选择 --create、--list 或 --disable');
    const repository = openDiskRepository(dataDir);
    if (!repository.load('users').some(user => user.id === userId)) throw new Error('网盘用户 ID 不存在');
    if (backendId && !repository.load('backends').some(item => item.id === backendId)) throw new Error('存储后端 ID 不存在');
    const bucketMappings = buckets.map(raw => {
        const at = String(raw || '').indexOf('=');
        if (at < 0) throw new Error('--bucket 格式为 bucket=diskSpace，默认分区写 bucket=');
        return { bucket: raw.slice(0, at), diskSpace: raw.slice(at + 1), ...(backendId ? { backendId } : {}) };
    });
    return credentials.create({ userId, bucketMappings });
}
if (require.main === module) {
    try { console.log(JSON.stringify(main(), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
