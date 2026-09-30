'use strict';
const path = require('node:path');
const { createS3Credentials } = require('../server/s3/credentials');
const { openDiskRepository } = require('../server/disk-repository');

function main(argv = process.argv.slice(2)) {
    let dataDir = path.resolve(process.env.TUNNEL_DATA_DIR || '.tunnel-data'), mode = '', userId = '', accessKeyId = '', backendId = '', remark = '';
    const buckets = [];
    const value = (index, flag) => { if (!argv[index] || argv[index].startsWith('--')) throw new Error(`${flag} 缺少参数值`); return argv[index]; };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--data-dir') dataDir = path.resolve(value(++i, arg));
        else if (arg === '--create' || arg === '--list') mode = arg.slice(2);
        else if (['--disable', '--enable', '--rotate'].includes(arg)) { mode = arg.slice(2); accessKeyId = value(++i, arg); }
        else if (arg === '--user-id') userId = value(++i, arg);
        else if (arg === '--bucket') buckets.push(value(++i, arg));
        else if (arg === '--backend-id') backendId = value(++i, arg);
        else if (arg === '--remark') remark = value(++i, arg);
        else throw new Error(`未知参数：${arg}`);
    }
    const credentials = createS3Credentials(dataDir);
    if (mode === 'list') return credentials.list();
    if (mode === 'disable') { credentials.disable(accessKeyId); return { disabled: accessKeyId }; }
    if (mode === 'enable') return credentials.update(accessKeyId, { enabled: true });
    if (mode === 'rotate') return credentials.rotate(accessKeyId);
    if (mode !== 'create') throw new Error('请选择 --create、--list、--disable、--enable 或 --rotate');
    const repository = openDiskRepository(dataDir);
    if (!repository.load('users').some(user => user.id === userId)) throw new Error('网盘用户 ID 不存在');
    if (backendId && !repository.load('backends').some(item => item.id === backendId)) throw new Error('存储后端 ID 不存在');
    const bucketMappings = buckets.map(raw => {
        const at = String(raw || '').indexOf('=');
        if (at < 0) throw new Error('--bucket 格式为 bucket=diskSpace，默认分区写 bucket=');
        return { bucket: raw.slice(0, at), diskSpace: raw.slice(at + 1), ...(backendId ? { backendId } : {}) };
    });
    return credentials.create({ userId, bucketMappings, remark });
}
if (require.main === module) {
    try { console.log(JSON.stringify(main(), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
