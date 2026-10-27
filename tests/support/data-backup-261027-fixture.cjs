'use strict';
// Real backup/drive modules with disposable SQLite data and an in-memory
// Telegram adapter. This fixture never reads production .tunnel-data or uploads
// to Telegram. The account/partition names are synthetic browser QA data.
const path = require('node:path');
const fs = require('node:fs/promises');
const { createFixture: createDriveFixture } = require('./pending-save-261012-fixture.cjs');
const { registerDataBackup } = require('../../server/data-backup');
const { createDiskPartitions } = require('../../server/disk-partitions');
async function create() {
    const drive = await createDriveFixture();
    const root = path.resolve(__dirname, '../..');
    const partitions = createDiskPartitions({ dataDir: drive.dataDir, spaces: drive.api.spaces });
    const full = partitions.createWithin('alice', 'FULL'), core = partitions.createWithin('bob', 'CORE');
    drive.api.spaces.get(full.scopeKey).createDirectory('alice', '系统备份/历史版本', 30);
    drive.api.spaces.get(core.scopeKey).createDirectory('bob', '核心数据', 30);
    await fs.mkdir(path.join(drive.dataDir, 'streaming-console'), { recursive: true });
    await fs.writeFile(path.join(drive.dataDir, 'streaming-console', 'fixture.txt'), '这是隔离系统备份验收文件。');
    await fs.mkdir(path.join(drive.dataDir, 'telegram-content-cache'), { recursive: true });
    await fs.writeFile(path.join(drive.dataDir, 'telegram-content-cache', 'excluded.txt'), '此缓存不应进入备份。');
    const backup = registerDataBackup(drive.app, { dataDir: drive.dataDir, root, diskAPI: drive.api, auth: drive.auth,
        requireAuth: (_req, _res, next) => next(), origin: req => req.protocol + '://' + req.get('host') });
    await backup.configure('full', { userId: 'alice', partitionId: full.id, folderPath: '系统备份' });
    await backup.configure('core', { userId: 'bob', partitionId: core.id, folderPath: '核心数据' });
    return { ...drive, backup, full, core, async close() { backup.close(); await backup.wait(); await drive.close(); } };
}
module.exports = { create };
if (require.main === module) create().then(fixture => {
    console.log(JSON.stringify({ base: fixture.base, browser: fixture.base + '/system-backup', dataDir: fixture.dataDir }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => fixture.close().then(() => process.exit()));
}).catch(error => { console.error(error); process.exitCode = 1; });
